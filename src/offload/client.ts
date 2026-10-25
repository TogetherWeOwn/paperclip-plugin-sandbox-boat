// Shim broker client: submit, incremental poll, heartbeat, cancel, recovery.
// Runs in the agent's environment (the `cargo` PATH shim); the only secret it
// holds is the run token in HTTP headers, never in a body. Local fallback
// happens only on a durable never-started receipt; every ambiguity ends in an
// explicit exit, never a silent replay.

import { exitForError, exitForTerminal } from "./errors.js";
import {
  OFFLOAD_BOUNDS,
  OFFLOAD_EXIT,
  OFFLOAD_VERSION,
  type OffloadCommandState,
  type OffloadDryRunResponse,
  type OffloadErrorCode,
  type OffloadErrorEnvelope,
  type OffloadReadResponse,
  type OffloadSyncBack,
} from "./protocol.js";

export type HttpResult = { ok: true; status: number; json: unknown } | { ok: false; error: string };

export interface BrokerHttp {
  post(path: string, body?: unknown): Promise<HttpResult>;
  get(path: string): Promise<HttpResult>;
}

export interface ShimRequest {
  argv: string[];
  cwdRelative: string;
  executionWorkspaceId: string;
  queueTimeoutMs: number;
  timeoutMs: number;
  processEnv: Record<string, string | undefined>;
}

export interface ClientDeps {
  http: BrokerHttp;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (bytes: Uint8Array) => void;
  stderr: (bytes: Uint8Array) => void;
  onSignal: (handler: (signal: "SIGINT" | "SIGTERM") => void) => void;
  randomId: () => string;
  runLocal: (argv: string[]) => Promise<number>;
  reportStaged: (syncBack: OffloadSyncBack) => void;
  reportUnknown: (info: { commandId: string }) => void;
}

export interface DryRunResult {
  mode: OffloadDryRunResponse["mode"];
  reason: string;
  profileId: string;
}

const POLL_MS = 500;
const TERM_COLOR = new Set(["auto", "always", "never"]);
const BACKTRACE = new Set(["0", "1", "full"]);

const TERMINAL: ReadonlySet<string> = new Set(["completed", "not_started", "cancelled", "failed", "unknown"]);

function signalExit(signal: "SIGINT" | "SIGTERM"): number {
  return signal === "SIGINT" ? 128 + 2 : 128 + 15;
}

/**
 * Build the request env from the process env. Only allowlisted keys travel;
 * RUSTFLAGS/RUSTDOCFLAGS stay local in v1 (the server profile cannot validate
 * them yet), and invalid enum values are omitted rather than sent as a 400.
 */
function buildEnv(processEnv: ShimRequest["processEnv"]): { local: true } | { local: false; env: Record<string, string> } {
  const rustflags = processEnv.RUSTFLAGS;
  const rustdocflags = processEnv.RUSTDOCFLAGS;
  if ((rustflags != null && rustflags !== "") || (rustdocflags != null && rustdocflags !== "")) return { local: true };
  const env: Record<string, string> = {};
  const termColor = processEnv.CARGO_TERM_COLOR;
  if (termColor !== undefined && TERM_COLOR.has(termColor)) env.CARGO_TERM_COLOR = termColor;
  const backtrace = processEnv.RUST_BACKTRACE;
  if (backtrace !== undefined && BACKTRACE.has(backtrace)) env.RUST_BACKTRACE = backtrace;
  return { local: false, env };
}

function asReadView(json: unknown, commandId: string): OffloadReadResponse | null {
  if (!json || typeof json !== "object") return null;
  const view = json as Record<string, unknown>;
  if (view.commandId !== commandId || typeof view.state !== "string") return null;
  if (!Array.isArray(view.events)) return null;
  return view as unknown as OffloadReadResponse;
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "OFFLOAD_UNAVAILABLE",
  "OFFLOAD_INVALID_REQUEST",
  "OFFLOAD_UNAUTHORIZED",
  "OFFLOAD_FORBIDDEN",
  "OFFLOAD_IDEMPOTENCY_CONFLICT",
  "OFFLOAD_SYNC_STAGED",
  "OFFLOAD_SYNC_CONFLICT",
  "OFFLOAD_EXECUTION_UNKNOWN",
  "OFFLOAD_RESULT_EXPIRED",
  "OFFLOAD_OUTPUT_LIMIT",
]);

function asError(json: unknown): OffloadErrorEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const code = (json as Record<string, unknown>).code;
  if (typeof code !== "string" || !KNOWN_CODES.has(code)) return null;
  return json as OffloadErrorEnvelope;
}

export async function runDryRun(request: ShimRequest, deps: ClientDeps): Promise<DryRunResult> {
  const env = buildEnv(request.processEnv);
  if (env.local) return { mode: "local", reason: "RUSTFLAGS/RUSTDOCFLAGS set; profile cannot validate them yet", profileId: "" };
  const commandId = deps.randomId();
  const response = await deps.http.post("/offload/exec", {
    version: OFFLOAD_VERSION,
    commandId,
    executionWorkspaceId: request.executionWorkspaceId,
    cwdRelative: request.cwdRelative,
    argv: request.argv,
    env: env.env,
    queueTimeoutMs: request.queueTimeoutMs,
    timeoutMs: request.timeoutMs,
    dryRun: true,
  });
  if (!response.ok) throw new Error(`offload dry-run failed: ${response.error}`);
  if (response.status !== 200) {
    const envelope = asError(response.json);
    throw new Error(`offload dry-run rejected: ${envelope?.code ?? `HTTP ${response.status}`}`);
  }
  const body = response.json as { mode: DryRunResult["mode"]; reason: string; profileId: string };
  return { mode: body.mode, reason: body.reason, profileId: body.profileId };
}

interface PollContext {
  request: ShimRequest;
  deps: ClientDeps;
  commandId: string;
  pendingSignal: () => "SIGINT" | "SIGTERM" | null;
}

async function cancelBestEffort(ctx: PollContext): Promise<void> {
  try {
    await ctx.deps.http.post(`/offload/commands/${ctx.commandId}/cancel`, { reason: "client_signal" });
  } catch {
    // Best effort: the guest deadline still bounds a lost cancel.
  }
}

function render(ctx: PollContext, view: OffloadReadResponse): void {
  for (const event of view.events) {
    const bytes = Buffer.from(event.dataBase64, "base64");
    if (event.stream === "stderr") ctx.deps.stderr(bytes);
    else ctx.deps.stdout(bytes);
  }
}

/**
 * Finish a terminal view. Returns the process exit, or null while running.
 * Local fallback happens only on a durable never-started receipt.
 */
async function finishIfTerminal(ctx: PollContext, view: OffloadReadResponse): Promise<number | null> {
  if (!TERMINAL.has(view.state)) return null;
  if (view.terminalError === "OFFLOAD_OUTPUT_LIMIT") return OFFLOAD_EXIT.syncStaged;
  if (!view.result) {
    if (view.state === "not_started" && view.remoteStarted === false && view.fallbackSafe === true) {
      return ctx.deps.runLocal(ctx.request.argv);
    }
    return OFFLOAD_EXIT.executionUnknown;
  }
  if (view.result.syncBack.state === "staged" || view.result.syncBack.state === "conflict") {
    ctx.deps.reportStaged(view.result.syncBack);
  }
  return exitForTerminal(view.result);
}

async function poll(ctx: PollContext, cursor: number): Promise<number> {
  const { deps, request, commandId } = ctx;
  let lastBeat = deps.now();
  // Reads are cheap and heartbeats renew; bound the whole poll by the command
  // timeout plus a grace minute, then cancel and report unknown.
  const deadline = deps.now() + request.timeoutMs + 60_000;
  for (;;) {
    const signal = ctx.pendingSignal();
    if (signal) {
      await cancelBestEffort(ctx);
      return signalExit(signal);
    }
    let response: HttpResult;
    try {
      response = await deps.http.get(`/offload/commands/${commandId}?after=${cursor}`);
    } catch {
      response = { ok: false, error: "read failed" };
    }
    if (response.ok && response.status === 200) {
      const view = asReadView(response.json, commandId);
      if (view) {
        render(ctx, view);
        cursor = view.nextCursor;
        const done = await finishIfTerminal(ctx, view);
        if (done !== null) return done;
      }
    } else if (response.ok && response.status === 410) {
      return OFFLOAD_EXIT.executionUnknown;
    } else if (response.ok && (response.status === 401 || response.status === 403)) {
      return OFFLOAD_EXIT.auth;
    } else if (response.ok && response.status === 400) {
      return OFFLOAD_EXIT.invalidRequest;
    }
    // Else transient (network or 5xx): the remote command continues; retry.
    if (deps.now() - lastBeat >= OFFLOAD_BOUNDS.heartbeatIntervalMs) {
      try {
        const beat = await deps.http.post(`/offload/commands/${commandId}/heartbeat`);
        if (beat.ok && beat.status === 410) return OFFLOAD_EXIT.executionUnknown;
        if (beat.ok && (beat.status === 401 || beat.status === 403)) return OFFLOAD_EXIT.auth;
        lastBeat = deps.now();
      } catch {
        // A lost heartbeat retries next interval; expiry cancels remotely.
      }
    }
    if (deps.now() >= deadline) {
      await cancelBestEffort(ctx);
      deps.reportUnknown({ commandId });
      return OFFLOAD_EXIT.executionUnknown;
    }
    await deps.sleep(POLL_MS);
  }
}

/**
 * Reconcile an ambiguous submit for at most ten seconds with the same command
 * ID. A running receipt resumes ordinary handling, a never-started receipt
 * permits exactly one bounded local fallback, and anything else exits 75.
 * Never cancel before the first read: the submit may have landed and the
 * command may be running, and an upfront cancel would kill it.
 */
async function recover(ctx: PollContext): Promise<number> {
  const { deps, commandId } = ctx;
  const deadline = deps.now() + OFFLOAD_BOUNDS.recoveryBudgetMs;
  let cursor = 0;
  for (;;) {
    const signal = ctx.pendingSignal();
    if (signal) {
      await cancelBestEffort(ctx);
      return signalExit(signal);
    }
    let response: HttpResult;
    try {
      response = await deps.http.get(`/offload/commands/${commandId}?after=${cursor}`);
    } catch {
      response = { ok: false, error: "read failed" };
    }
    if (response.ok && response.status === 200) {
      const view = asReadView(response.json, commandId);
      if (view) {
        render(ctx, view);
        cursor = view.nextCursor;
        if (view.state === "not_started" && view.remoteStarted === false && view.fallbackSafe === true) {
          return deps.runLocal(ctx.request.argv);
        }
        const done = await finishIfTerminal(ctx, view);
        if (done !== null) return done;
        if (isLive(view.state)) return poll(ctx, cursor);
        // Queued/unknown: the submit may still land; keep waiting.
      }
    } else if (response.ok && response.status === 410) {
      return OFFLOAD_EXIT.executionUnknown;
    } else if (response.ok && (response.status === 401 || response.status === 403)) {
      return OFFLOAD_EXIT.auth;
    }
    // 400 unknown-command and transport failures: the submit may still land.
    if (deps.now() >= deadline) {
      deps.reportUnknown({ commandId });
      return OFFLOAD_EXIT.executionUnknown;
    }
    await deps.sleep(POLL_MS);
  }
}

function isLive(state: OffloadCommandState | string): boolean {
  return state === "running" || state === "starting" || state === "syncing_in" || state === "syncing_out";
}

export async function runOffload(request: ShimRequest, deps: ClientDeps): Promise<number> {
  const env = buildEnv(request.processEnv);
  if (env.local) return deps.runLocal(request.argv);
  const commandId = deps.randomId();
  let pending: "SIGINT" | "SIGTERM" | null = null;
  deps.onSignal((signal) => {
    pending ??= signal;
  });
  const ctx: PollContext = { request, deps, commandId, pendingSignal: () => pending };

  let submit: HttpResult;
  try {
    submit = await deps.http.post("/offload/exec", {
      version: OFFLOAD_VERSION,
      commandId,
      executionWorkspaceId: request.executionWorkspaceId,
      cwdRelative: request.cwdRelative,
      argv: request.argv,
      env: env.env,
      queueTimeoutMs: request.queueTimeoutMs,
      timeoutMs: request.timeoutMs,
      dryRun: false,
    });
  } catch {
    submit = { ok: false, error: "submit failed" };
  }
  if (pending) {
    await cancelBestEffort(ctx);
    return signalExit(pending);
  }
  if (!submit.ok) return recover(ctx);
  if (submit.status === 202) return poll(ctx, 0);
  if (submit.status === 200) {
    // Duplicate submit: the body is the current read view.
    const view = asReadView(submit.json, commandId);
    if (!view) return recover(ctx);
    render(ctx, view);
    const done = await finishIfTerminal(ctx, view);
    if (done !== null) return done;
    return poll(ctx, view.nextCursor);
  }
  const envelope = asError(submit.json);
  if (!envelope) {
    if (submit.status === 503 || submit.status >= 500) return recover(ctx);
    if (submit.status === 401 || submit.status === 403) return OFFLOAD_EXIT.auth;
    if (submit.status === 410) return OFFLOAD_EXIT.executionUnknown;
    return OFFLOAD_EXIT.invalidRequest;
  }
  const decision = exitForError(envelope);
  if (decision.action === "fallback") return deps.runLocal(request.argv);
  // A structured 503 without a never-started guarantee is still ambiguous.
  if (submit.status === 503) return recover(ctx);
  return decision.code;
}

export type { OffloadErrorCode };
