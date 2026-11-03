// Durable command evidence, independent of provider and transport implementations.
import { createHash, randomUUID } from "node:crypto";
import type { OffloadCommand, OffloadResult, OffloadWarm, OffloadSyncBack } from "./offload.js";
import type { CommandExit, GuestIdentity } from "./offload-lifecycle.js";
import { MAX_DURATION_SECONDS } from "./offload/duration-history.js";

export interface OffloadStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  create(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface OffloadIdentity extends Partial<GuestIdentity> {
  companyId: string;
  runId: string;
  commandId: string;
  digest: string;
  sandboxId: string;
  guestBootId: string;
  journalGeneration: number;
}

export type OffloadState = "accepted" | "queued" | "syncing_in" | "starting" | "running" |
  "syncing_out" | "completed" | "not_started" | "cancelled" | "failed" | "unknown";
export interface OffloadOutputEvent { seq: number; stream: "stdout" | "stderr"; dataBase64: string }
export interface OffloadReadView extends OffloadCommandView { events: OffloadOutputEvent[]; nextCursor: number }

export interface OffloadRecord {
  version: 1;
  companyId: string;
  runId: string;
  commandId: string;
  command?: OffloadCommand;
  digest: string;
  state: OffloadState;
  identity: OffloadIdentity | null;
  acceptedAt: number;
  updatedAt: number;
  resultAt: number | null;
  result: OffloadResult | null;
  remoteStarted: boolean | null;
  fallbackSafe: boolean;
  cancelRequested?: string;
  output?: OffloadOutputEvent[];
  tombstone?: boolean;
  // First sweep that saw the run permanently terminal, persisted on the
  // tombstone: a host that cannot report terminatedAt still bounds retention.
  runTerminalSeenAt?: number;
}

export interface OffloadReceipt {
  version: 1;
  kind: "marker" | "started" | "result" | "not_started";
  identity: OffloadIdentity;
  result?: { exitCode: number; seconds: number };
}

export interface OffloadRunState {
  permanentlyTerminal: boolean;
  terminatedAt: number | null;
  tokenExpiresAt: number;
}

export interface OffloadSync {
  push(sandboxId: string, command: OffloadCommand): Promise<void>;
  // Collection is adapter-owned data; orchestration passes it to stage intact.
  collect(sandboxId: string, command: OffloadCommand): Promise<unknown>;
  stage(sandboxId: string, command: OffloadCommand, collected: unknown): Promise<OffloadSyncBack | void>;
  // Drop the host-side upload after a command failed before transport; never throws.
  discard?(sandboxId: string, command: OffloadCommand): Promise<void>;
  // Collect failed after a completed transport: the guest mirror cannot be
  // trusted as a delta base, so the next push wipes and fully resyncs it.
  // Required (not optional) so an adapter cannot silently drop the marking.
  markSuspect(sandboxId: string, command: OffloadCommand): Promise<void>;
}

export interface OffloadDurableDeps {
  journalStore: OffloadStore;
  guestReceipts: {
    read(identity: OffloadIdentity): Promise<unknown>;
    // Read the actual boot identity through the pinned guest transport before intent.
    bootId?(sandboxId: string): Promise<string>;
  };
  resolveRunState(companyId: string, runId: string): Promise<OffloadRunState>;
  sync: OffloadSync;
}

export interface OffloadCommandView {
  version: 1;
  commandId: string;
  state: OffloadState;
  remoteStarted: boolean | null;
  fallbackSafe: boolean;
  /** Why a never-started command was refused (bounded, server-authored).
   * Present only on `not_started` views whose unavailable result carried a
   * reason, so the bridge can journal it instead of a generic refusal. */
  fallbackReason?: string;
  result: {
    exitCode: number;
    signal: null;
    timedOut: boolean;
    cancelled: boolean;
    syncBack: OffloadSyncBack;
    usageRecordId: null;
  } | null;
}

const DAY = 86_400_000;
// Per-command retained bytes, not the much smaller read-page limit. The runner
// must propagate output rejection so lifecycle cleanup can stop a flooding guest.
const OUTPUT_LIMIT_BYTES = 1_048_576;
const OUTPUT_LIMIT_EVENTS = 16_384;
const TERMINAL = new Set<OffloadState>(["completed", "not_started", "cancelled", "failed"]);
const PRE_START = new Set<OffloadState>(["accepted", "queued", "syncing_in"]);
const STATES = new Set<OffloadState>([...TERMINAL, ...PRE_START, "starting", "running", "syncing_out", "unknown"]);
/** First-party failure with an allowlisted code, plus — only where a site
 * knows which sub-cause refused — a server-log detail token. The detail is
 * validated again before anyone logs it and never joins a client-visible
 * reason; see describePreStartFailure. */
export const offloadError = (code: string, detail?: string) =>
  Object.assign(new Error(code), { code, ...(detail !== undefined ? { detail } : {}) });

/** The pre-start steps of `OffloadJournal.run()`, in dispatch order. A failure
 * in any of them happens before transport, so it is a known non-start — but
 * which step failed (and its error code) is exactly what an operator needs,
 * and what the generic "command failed before durable starting intent" used
 * to discard. */
export type PreStartStep = "sync-in journal commit" | "sync push" | "guest boot identity"
  | "guest lifecycle prepare" | "durable starting intent commit" | "pool identity bind";

export interface PreStartFailure {
  step: PreStartStep;
  /** Sanitized first-party/errno error code, or null. */
  code: string | null;
  /** Sanitized sub-cause token for the server log only, or null. Never
   * joins `reason`: the reason crosses to the client, the detail must not. */
  detail: string | null;
  /** Server-authored reason safe for the journal result and shim announcement. */
  reason: string;
}

// The failure record is journal-authored: the step comes from the call site,
// the reason is built here, and only the error's `code` may join it — and
// only when it is a known first-party prefix or an errno token. Raw error
// messages never cross (they can carry guest diagnostics, source paths or
// environment bytes; see the guest RPC boundary), and metadata is never
// written to an adapter-owned error object, whose accessors, frozen state
// or reuse across commands must not affect attribution. The property reads
// are guarded: describing a failure never throws.
//
// One more token may cross for the server log only: a first-party site that
// knows which sub-cause refused (a guest-probe step, an RPC transport
// failure, the host env gate) attaches it as `detail`. It is read under the
// same guard and kept only when it matches the fixed token shape below, so
// guest- or adapter-influenced bytes still cannot reach the log — and it is
// never appended to `reason`, which crosses to the client unchanged.
const SAFE_ERROR_CODE = /^(?:(?:OFFLOAD|SYNC|BOAT)_[A-Z0-9_]{1,56}|E[A-Z]{2,11})$/;
const SAFE_PRESTART_DETAIL = /^[a-z][a-z0-9_]{0,40}(?::(?:E[A-Z]{2,11}|[A-Z][A-Z0-9_]{1,56}))?(?::(?:session_delegated|session_not_delegated|session_placement_unknown))?$/;
export function validPreStartDetail(value: unknown): string | null {
  return typeof value === "string" && SAFE_PRESTART_DETAIL.test(value) ? value : null;
}
function describePreStartFailure(step: PreStartStep, error: unknown): PreStartFailure {
  let code: string | null = null;
  try {
    const raw = (error as { code?: unknown } | null)?.code;
    if (typeof raw === "string" && SAFE_ERROR_CODE.test(raw)) code = raw;
  } catch { /* A throwing accessor contributes no code. */ }
  let detail: string | null = null;
  try {
    detail = validPreStartDetail((error as { detail?: unknown } | null)?.detail);
  } catch { /* A throwing accessor contributes no detail. */ }
  const reason = code === "OFFLOAD_COMMAND_NOT_STARTED"
    ? "cancelled before durable starting intent"
    : `${step} failed before the command could start${code ? ` (${code})` : ""}`;
  return { step, code, detail, reason };
}

export function commandDigest(command: OffloadCommand): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => [key, canonical(child)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(command))).digest("hex");
}

function component(value: string): string {
  if (!value || value.includes("/") || value.includes("\0")) throw offloadError("OFFLOAD_INVALID_REQUEST");
  return value;
}
export function commandKey(command: Pick<OffloadCommand, "companyId" | "runId" | "commandId">): string {
  return `command/${component(command.companyId)}/${component(command.runId)}/${component(command.commandId)}`;
}
export function guestReceiptKey(identity: OffloadIdentity, kind: OffloadReceipt["kind"]): string {
  return `guest/${component(identity.companyId)}/${component(identity.runId)}/${component(identity.commandId)}/${kind}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validGuestIdentity(value: unknown): value is GuestIdentity {
  return object(value) && typeof value.guestBootId === "string" && value.guestBootId.length > 0
    && Number.isSafeInteger(value.journalGeneration) && (value.journalGeneration as number) > 0
    && Number.isSafeInteger(value.processGroupId) && (value.processGroupId as number) > 0
    && typeof value.cgroupPath === "string" && value.cgroupPath.startsWith("/") && value.cgroupPath !== "/"
    && !value.cgroupPath.includes("\0") && value.cgroupPath.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..")
    && Number.isSafeInteger(value.heartbeatDeadline) && Number.isSafeInteger(value.guestDeadline);
}
export function validIdentity(value: unknown): value is OffloadIdentity {
  return object(value) && ["companyId", "runId", "commandId", "digest", "sandboxId", "guestBootId"]
    .every((key) => typeof value[key] === "string" && value[key].length > 0)
    && Number.isSafeInteger(value.journalGeneration) && (value.journalGeneration as number) > 0
    && (!["processGroupId", "cgroupPath", "heartbeatDeadline", "guestDeadline"].some((key) => key in value) || validGuestIdentity(value));
}
export function matchingReceipt(value: unknown, identity: OffloadIdentity): value is OffloadReceipt {
  if (!object(value) || value.version !== 1 || !validIdentity(value.identity)) return false;
  const actual = value.identity;
  // Interest renewal changes a deadline, not the owned process/subtree. Guest
  // result receipts retain the original heartbeat deadline from spawn.
  if (!(Object.keys(identity) as Array<keyof OffloadIdentity>)
    .filter((key) => key !== "heartbeatDeadline").every((key) => actual[key] === identity[key])) return false;
  if (!["marker", "started", "result", "not_started"].includes(String(value.kind))) return false;
  // Guest result receipts are untrusted: only the exact two fields the
  // supervisor writes cross this boundary, with a safe-integer exit in
  // 0..255 and finite non-negative seconds. Extra keys (a guest-asserted
  // cancelled/timedOut/status) or out-of-range facts fail the match so the
  // recovery path holds unknown instead of adopting them.
  if (value.kind !== "result") return true;
  if (!object(value.result)) return false;
  const facts = value.result as Record<string, unknown>;
  return Object.keys(facts).every((key) => key === "exitCode" || key === "seconds")
    && Number.isSafeInteger(facts.exitCode) && (facts.exitCode as number) >= 0 && (facts.exitCode as number) <= 255
    && typeof facts.seconds === "number" && Number.isFinite(facts.seconds) && (facts.seconds as number) >= 0;
}

function parseRecord(value: unknown, key: string): OffloadRecord {
  if (!object(value) || value.version !== 1 || typeof value.companyId !== "string" || typeof value.runId !== "string"
    || typeof value.commandId !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || !STATES.has(value.state as OffloadState) || !Number.isFinite(value.acceptedAt) || !Number.isFinite(value.updatedAt)
    || (value.resultAt !== null && !Number.isFinite(value.resultAt))
    || (value.runTerminalSeenAt !== undefined && !Number.isFinite(value.runTerminalSeenAt))
    || ![null, false, true].includes(value.remoteStarted as null | boolean) || typeof value.fallbackSafe !== "boolean"
    || (value.identity !== null && !validIdentity(value.identity))) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  if (value.output !== undefined && (!Array.isArray(value.output) || !value.output.every((event, index) =>
    object(event) && event.seq === index + 1 && ["stdout", "stderr"].includes(String(event.stream))
    && typeof event.dataBase64 === "string" && event.dataBase64.length > 0 && event.dataBase64.length <= 1368
    && Buffer.from(event.dataBase64, "base64").length <= 1024
    && Buffer.from(event.dataBase64, "base64").toString("base64") === event.dataBase64))) {
    throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  }
  const record = value as unknown as OffloadRecord;
  if (commandKey(record) !== key || (record.command && (commandKey(record.command) !== key || commandDigest(record.command) !== record.digest))
    || (!record.command && !record.tombstone) || (record.tombstone && !TERMINAL.has(record.state))) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  if (record.identity && (record.identity.companyId !== record.companyId || record.identity.runId !== record.runId
    || record.identity.commandId !== record.commandId || record.identity.digest !== record.digest)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  return record;
}

export interface JournalLifecycle {
  remember?(identity: OffloadIdentity): void;
  prepare(sandboxId: string, command: OffloadCommand, base: OffloadIdentity): Promise<OffloadIdentity>;
  discard(identity: OffloadIdentity): void;
  cancel(identity: OffloadIdentity, reason: string): Promise<void>;
  heartbeat(identity: OffloadIdentity): void;
}

interface JournalPool {
  bind?(identity: OffloadIdentity): Promise<void>;
  hold(identity: OffloadIdentity, command?: OffloadCommand): Promise<void>;
  release(identity: OffloadIdentity): Promise<void>;
  cancel(command: OffloadCommand, result: OffloadResult): Promise<void>;
}

// One authoritative worker only. Exclusive create fences duplicate IDs, not
// independent workers racing different IDs for a run's 512-slot capacity.
export class OffloadJournal {
  private chain: Promise<unknown> = Promise.resolve();
  private startup: Promise<void> | null = null;
  private readonly inFlight = new Map<string, { digest: string; task: Promise<OffloadResult>; ready: Promise<OffloadCommandView> }>();
  private readonly active = new Map<string, OffloadRecord>();
  /** Journal-authored record of the pre-start step that failed for a live
   * command, so `finish()` converts its `unknown` into a `not_started` that
   * names the site and the executor can log it. Set by `run()`, consumed by
   * `finish()`, and dropped when the execution settles either way. */
  private readonly preStartFailures = new Map<string, PreStartFailure>();
  private readonly held = new Map<string, OffloadIdentity>();
  private readonly transitions = new Map<string, Promise<unknown>>();

  // Cancellation and starting arbitrate on one record, never on a global lock
  // held across queue-refusal I/O or guest sync/transport.
  private async transition<T>(record: OffloadRecord, fn: () => Promise<T>): Promise<T> {
    const key = commandKey(record);
    const previous = this.transitions.get(key) ?? Promise.resolve();
    const task = previous.then(fn, fn);
    const fence = task.catch(() => undefined);
    this.transitions.set(key, fence);
    try { return await task; } finally {
      if (this.transitions.get(key) === fence) this.transitions.delete(key);
    }
  }

  preStartResult(command: OffloadCommand): OffloadResult | null {
    const record = this.active.get(commandKey(command));
    return record?.state === "not_started" ? record.result : null;
  }

  /** The pre-start failure `run()` recorded for this command, if any, until
   * the execution settles. Lets the executor log and surface the exact site
   * without inspecting the (adapter-owned) thrown error. */
  preStartFailure(command: OffloadCommand): PreStartFailure | null {
    const failure = this.preStartFailures.get(commandKey(command));
    return failure ? { ...failure } : null;
  }

  // Re-read durable state inside the record fence. A snapshot taken before the
  // fence may predate a live execution object or a racing commit; the fence
  // orders callbacks but cannot merge separate objects, so every pre-start
  // decision must validate the current durable state before committing.
  private async refresh(record: OffloadRecord): Promise<void> {
    const key = commandKey(record);
    Object.assign(record, parseRecord(await this.deps.journalStore.get(key), key));
  }

  private async beforeStart(record: OffloadRecord, patch: Partial<OffloadRecord>): Promise<void> {
    await this.transition(record, async () => {
      await this.refresh(record);
      if (!PRE_START.has(record.state) || record.cancelRequested) throw offloadError("OFFLOAD_COMMAND_NOT_STARTED");
      await this.commit(record, patch);
    });
  }

  constructor(private readonly deps: OffloadDurableDeps, private readonly now: () => number,
    private readonly pool: JournalPool, private readonly lifecycle?: JournalLifecycle) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn, fn);
    this.chain = task.catch(() => undefined);
    return task;
  }

  pending(): Promise<OffloadResult>[] { return [...this.inFlight.values()].map((entry) => entry.task); }

  private async checkRun(companyId: string, runId: string): Promise<void> {
    const run = await this.deps.resolveRunState(companyId, runId);
    if (run.permanentlyTerminal) throw offloadError("OFFLOAD_FORBIDDEN");
  }

  /**
   * Settle every non-terminal record bound to this sandbox as terminal-read
   * `unknown`: the guest rebooted or is gone (archived/cancelled/deleted), so
   * no command processes survive and the old command must never replay. An
   * existing unknown reply is preserved byte-for-byte; the settled marker is
   * resultAt (crash-pending unknown keeps resultAt null), so replay returns
   * the result without re-holding and retention stays neutral (unknown is
   * never tombstoned). Returns the settled count.
   */
  /** True when a non-terminal record bound to this sandbox still awaits its
   * receipt (crash-pending unknown included; settled unknown excluded).
   * Read-only: quarantine reconciliation asks this before rejoining a
   * clean-observed VM, so an unverified disk never rejoins on a live receipt. */
  async hasUnsettled(sandboxId: string): Promise<boolean> {
    return this.serialize(async () => {
      for (const key of await this.deps.journalStore.list("command/")) {
        const record = parseRecord(await this.deps.journalStore.get(key), key);
        if (record.identity?.sandboxId !== sandboxId || TERMINAL.has(record.state)) continue;
        if (record.state === "unknown" && record.resultAt !== null) continue; // already settled
        return true;
      }
      return false;
    });
  }

  async settleSandboxUnknown(sandboxId: string): Promise<number> {
    return this.serialize(async () => {
      let settled = 0;
      for (const key of await this.deps.journalStore.list("command/")) {
        const record = parseRecord(await this.deps.journalStore.get(key), key);
        if (record.identity?.sandboxId !== sandboxId || TERMINAL.has(record.state)) continue;
        if (record.state === "unknown" && record.resultAt !== null) continue; // already settled
        const result = record.result?.status === "unknown" ? record.result : this.unknown(record);
        await this.deps.journalStore.set(key, { ...record, state: "unknown", result,
          resultAt: this.now(), remoteStarted: null, fallbackSafe: false, updatedAt: this.now() });
        // Only this command's hold is dropped: a hold for another command on
        // the same sandbox (a reused slot) is never ours to release here.
        this.held.delete(key);
        settled += 1;
      }
      return settled;
    });
  }

  async recover(): Promise<void> {
    if (!this.startup) {
      this.startup = this.serialize(async () => {
        for (const key of await this.deps.journalStore.list("command/")) {
          const record = parseRecord(await this.deps.journalStore.get(key), key);
          if (record.identity) this.lifecycle?.remember?.(record.identity);
          if (this.settled(record)) continue; // settled unknown: terminal-read, never re-held
          if (!TERMINAL.has(record.state) && record.identity) await this.hold(record);
          if (!TERMINAL.has(record.state) && !PRE_START.has(record.state) && !record.identity) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        }
      });
      // A rejected scan must not wedge the journal: clear the cache so the next
      // call retries reconciliation after a transient store failure. Awaiting
      // callers still observe this rejection.
      this.startup.catch(() => { this.startup = null; });
    }
    await this.startup;
  }

  async execute(command: OffloadCommand, launch: () => Promise<OffloadResult>): Promise<OffloadResult> {
    return await (await this.begin(command, launch)).task;
  }

  async start(command: OffloadCommand, launch: () => Promise<OffloadResult>): Promise<OffloadCommandView> {
    return await (await this.begin(command, launch)).ready;
  }

  private async begin(command: OffloadCommand, launch: () => Promise<OffloadResult>) {
    // This must precede startup scanning, journal reads and even cached replies.
    await this.checkRun(command.companyId, command.runId);
    const key = commandKey(command);
    const digest = commandDigest(command);
    const pending = this.inFlight.get(key);
    if (pending) {
      if (pending.digest !== digest) throw offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT");
      return pending;
    }
    let accepted!: (view: OffloadCommandView) => void;
    let rejected!: (error: unknown) => void;
    const ready = new Promise<OffloadCommandView>((resolve, reject) => { accepted = resolve; rejected = reject; });
    // execute-only callers need not observe the separate start acknowledgement.
    void ready.catch(() => {});
    const task = this.executeOnce(command, digest, launch, accepted);
    const entry = { digest, task, ready };
    this.inFlight.set(key, entry);
    void task.then((result) => {
      // The existing bounded-ID admission can refuse without allocating a
      // record; start must settle too, without suggesting a remote effect.
      if (result.status === "unavailable") accepted({ version: 1, commandId: command.commandId,
        state: "not_started", remoteStarted: false, fallbackSafe: true,
        fallbackReason: result.reason.slice(0, 256), result: null });
    }, rejected);
    void task.finally(() => { if (this.inFlight.get(key) === entry) this.inFlight.delete(key); }).catch(() => {});
    return entry;
  }

  private async executeOnce(command: OffloadCommand, digest: string, launch: () => Promise<OffloadResult>,
    accepted: (view: OffloadCommandView) => void): Promise<OffloadResult> {
    await this.recover();
    const key = commandKey(command);
    const admission = await this.serialize(async () => {
      const existing = await this.deps.journalStore.get(key);
      if (existing !== null) {
        const record = parseRecord(existing, key);
        if (record.digest !== digest) throw offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT");
        return { record, fresh: false };
      }
      const prefix = `command/${component(command.companyId)}/${component(command.runId)}/`;
      if ((await this.deps.journalStore.list(prefix)).length >= 512) return null;
      const at = this.now();
      const record: OffloadRecord = { version: 1, companyId: command.companyId, runId: command.runId,
        commandId: command.commandId, command: structuredClone(command), digest, state: "accepted", identity: null,
        acceptedAt: at, updatedAt: at, resultAt: null, result: null, remoteStarted: false, fallbackSafe: false };
      if (!await this.deps.journalStore.create(key, record)) {
        const winner = parseRecord(await this.deps.journalStore.get(key), key);
        if (winner.digest !== digest) throw offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT");
        return { record: winner, fresh: false };
      }
      return { record, fresh: true };
    });
    if (!admission) return this.unavailable(command, "run command-ID capacity exhausted");
    const { record, fresh } = admission;
    if (!fresh) {
      this.checkExpiry(record);
      accepted(this.view(record));
      return await this.replay(record);
    }
    this.active.set(key, record);
    try {
      await this.transition(record, async () => {
        // A cancellation may have committed not_started between admission and
        // this fence; never overwrite that refusal with a stale queued commit.
        await this.refresh(record);
        if (PRE_START.has(record.state)) await this.commit(record, { state: "queued" });
      });
      accepted(this.view(record));
      if (record.state === "not_started") return record.result!;
      const result = await launch();
      return result.status === "unavailable" ? await this.finish(command, result) : result;
    } finally {
      this.active.delete(key);
      this.preStartFailures.delete(key);
    }
  }

  private async commit(record: OffloadRecord, patch: Partial<OffloadRecord>): Promise<void> {
    const next = { ...record, ...patch, updatedAt: this.now() };
    await this.deps.journalStore.set(commandKey(record), next);
    Object.assign(record, next); // Never advance memory past the durable boundary.
  }

  async run(sandboxId: string, command: OffloadCommand,
    transport: (sandboxId: string, command: OffloadCommand, identity?: OffloadIdentity) => Promise<CommandExit>) {
    const record = this.active.get(commandKey(command))!;
    // Every pre-start step records its failure under its own name for
    // finish() and the executor log: a non-start must say which site refused,
    // never collapse into one generic string for all of them. The original
    // error is rethrown untouched.
    this.preStartFailures.delete(commandKey(command));
    const step = async <T>(name: PreStartStep, fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (error) {
        this.preStartFailures.set(commandKey(command), describePreStartFailure(name, error));
        throw error;
      }
    };
    await step("sync-in journal commit", () => this.beforeStart(record, { state: "syncing_in" }));
    // Start the sync in the same continuation as the state check. A subsequent
    // cancellation can fence spawn, but need not abort an already-running push.
    if (record.state === "not_started" || record.cancelRequested) {
      const cancelled = offloadError("OFFLOAD_COMMAND_NOT_STARTED");
      this.preStartFailures.set(commandKey(command), describePreStartFailure("sync push", cancelled));
      throw cancelled;
    }
    await step("sync push", () => this.deps.sync.push(sandboxId, command));
    // Once the transport is invoked the guest may have run: a later failure,
    // transport or collect/stage alike, keeps the upload (and any partially
    // staged return) for receipt reconciliation; the retention sweep reclaims
    // it. Only a failure before transport ends the command's use of it.
    let transported = false;
    try {
      const bootId = await step("guest boot identity", async () => {
        const id = this.deps.guestReceipts.bootId ? await this.deps.guestReceipts.bootId(sandboxId) : `unverified:${randomUUID()}`;
        if (!id) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        return id;
      });
      const base: OffloadIdentity = { companyId: command.companyId, runId: command.runId, commandId: command.commandId,
        digest: record.digest, sandboxId, guestBootId: bootId, journalGeneration: 1 };
      const identity = this.lifecycle
        ? await step("guest lifecycle prepare", () => this.lifecycle!.prepare(sandboxId, command, base)) : base;
      try {
        await step("durable starting intent commit", () => this.beforeStart(record, { state: "starting", identity, remoteStarted: null }));
        await step("pool identity bind", async () => { await this.pool.bind?.(identity); });
      } catch (error) {
        // A failed commit or pre-start cancellation must not retain an entry
        // registered by prepare(); neither watchdog nor transport was invoked.
        this.lifecycle?.discard(identity);
        throw error;
      }
      transported = true;
      const result = await transport(sandboxId, command, identity);
      // The legacy transport resolves at exit, not at spawn. Do not claim a
      // running acknowledgement until it actually returns evidence of execution.
      await this.transition(record, async () => {
        await this.commit(record, { state: "running", remoteStarted: true });
        await this.commit(record, { state: "syncing_out" });
      });
      const syncBack = await this.syncOutAfterTransport(sandboxId, command);
      return { ...result, ...(syncBack ? { syncBack } : {}) };
    } catch (error) {
      if (!transported) await this.deps.sync.discard?.(sandboxId, command);
      throw error;
    }
  }

  private async syncOut(sandboxId: string, command: OffloadCommand): Promise<OffloadSyncBack | void> {
    const collected = await this.deps.sync.collect(sandboxId, command);
    const staged = await this.deps.sync.stage(sandboxId, command, collected);
    return staged === undefined ? undefined : structuredClone(staged);
  }

  /**
   * Collect after the transport already returned an exit. A *deterministic*
   * collect failure — the sync adapter tags it `collectDeterministic` when
   * guest mirror content (a special file, an over-limit scan, a malformed
   * scan result) makes collection impossible no matter how often it is
   * retried — is not an execution unknown: the command completed, so report
   * its real exit with a truncated sync-back, mark the mirror suspect for a
   * wipe on the next push, and drop the upload. Every other collect failure
   * (transport loss during collect, say) keeps the held-for-reconciliation
   * path, and stage failures always do.
   */
  private async syncOutAfterTransport(sandboxId: string, command: OffloadCommand): Promise<OffloadSyncBack | void> {
    let collected: unknown;
    try {
      collected = await this.deps.sync.collect(sandboxId, command);
    } catch (error) {
      if ((error as { collectDeterministic?: unknown } | null)?.collectDeterministic !== true) throw error;
      await this.deps.sync.markSuspect(sandboxId, command).catch(() => undefined);
      await this.deps.sync.discard?.(sandboxId, command).catch(() => undefined);
      return { state: "truncated", changedPaths: [], conflictPaths: [], artifactId: null };
    }
    const staged = await this.deps.sync.stage(sandboxId, command, collected);
    return staged === undefined ? undefined : structuredClone(staged);
  }

  async finish(command: OffloadCommand, result: OffloadResult): Promise<OffloadResult> {
    const record = this.active.get(commandKey(command))!;
    const committed = await this.transition(record, async () => {
      if (TERMINAL.has(record.state)) return record.result!;
      // Cancellation after guest exit still cancels the command lifecycle, but
      // cannot erase execution or drop staged changes. A timeout keeps exit 124.
      if (result.status === "completed" && record.cancelRequested && !result.timedOut) {
        result = { ...result, cancelled: true, exitCode: 130 };
      }
      // No transport is invoked before the starting commit. A sync/boot-ID
      // failure is therefore a known non-start, not identity-less uncertainty.
      // Name the step that failed (recorded by run()); the generic string
      // remains only for a pre-start unknown no step claimed.
      if (PRE_START.has(record.state) && result.status === "unknown") {
        result = this.unavailable(command,
          this.preStartFailures.get(commandKey(command))?.reason ?? "command failed before durable starting intent");
      }
      // Guest-controlled facts never commit unvalidated: a malformed exit
      // commits unknown (holding the reservation) instead of throwing past
      // it. The no-lifecycle journal path runs runCommand with no upstream
      // validator, so this is the fence for that reachable path.
      if (result.status !== "unavailable") {
        const exit = (result as { exitCode?: unknown }).exitCode;
        const secs = (result as { seconds?: unknown }).seconds;
        if (!Number.isInteger(exit) || !Number.isFinite(secs) || (secs as number) < 0) {
          result = this.unknown(record);
        }
      }
      if (result.status === "unavailable") {
        if (!PRE_START.has(record.state)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
        this.preStartFailures.delete(commandKey(command));
      } else if (result.status === "unknown") {
        await this.commit(record, { state: "unknown", result, resultAt: null, remoteStarted: null, fallbackSafe: false });
      } else {
        await this.commit(record, { state: result.cancelled ? "cancelled" : "completed", result, resultAt: this.now(), remoteStarted: true, fallbackSafe: false });
      }
      return result;
    });
    if (committed.status === "unknown") await this.hold(record);
    return committed;
  }

  private unavailable(command: Pick<OffloadCommand, "commandId">, reason: string): OffloadResult {
    return { status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: command.commandId, remoteStarted: false, fallbackSafe: true, reason };
  }

  private unknown(record: OffloadRecord): OffloadResult {
    return { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: record.commandId, sandboxId: record.identity?.sandboxId ?? "",
      warm: "cold", queueWaitMs: 0, remoteStarted: true, fallbackSafe: false, exitCode: 75, seconds: 0, dollars: 0,
      reason: "guest receipt verification required; execution must not be replayed" };
  }

  /** A settled unknown (resultAt set by settleSandboxUnknown) reads terminally,
   * unlike crash-pending unknown (resultAt null) which still awaits receipts. */
  private settled(record: OffloadRecord): boolean {
    return record.state === "unknown" && record.resultAt !== null;
  }

  private async hold(record: OffloadRecord): Promise<void> {
    if (record.identity) {
      this.held.set(commandKey(record), record.identity);
      await this.pool.hold(record.identity, record.command);
    }
  }
  private async release(record: OffloadRecord): Promise<void> {
    const identity = this.held.get(commandKey(record));
    this.held.delete(commandKey(record));
    if (identity && ![...this.held.values()].some((other) => other.sandboxId === identity.sandboxId)) await this.pool.release(identity);
  }

  private async replay(record: OffloadRecord): Promise<OffloadResult> {
    if (record.tombstone || (TERMINAL.has(record.state) && record.resultAt !== null && this.now() - record.resultAt >= DAY)) {
      throw offloadError("OFFLOAD_RESULT_EXPIRED");
    }
    if (TERMINAL.has(record.state)) {
      if (!record.result) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      return record.result;
    }
    if (this.settled(record)) {
      // The sandbox is gone; the preserved unknown never replays or re-holds.
      if (!record.result) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      return record.result;
    }
    if (PRE_START.has(record.state)) {
      const result = this.unavailable(record, "recovered before durable starting intent");
      await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
      return result;
    }
    await this.hold(record);
    if (this.lifecycle) {
      // Observation cannot certify cleanup or revoke a watchdog. Preserve an
      // existing ambiguous reply byte-for-byte; never synthesize a new execution.
      const result = record.result?.status === "unknown" ? record.result : this.unknown(record);
      await this.commit(record, { state: "unknown", result, resultAt: null, remoteStarted: null, fallbackSafe: false });
      return result;
    }
    let answer: unknown = null;
    try { if (record.identity) answer = await this.deps.guestReceipts.read(record.identity); } catch { /* Hold on transport loss. */ }
    if (record.identity && matchingReceipt(answer, record.identity)) {
      if (answer.kind === "result") {
        const raw = answer.result!;
        // Resume only output collection/staging, never command execution.
        // Rebuild from named facts: a receipt that passed matchingReceipt
        // carries exactly exitCode/seconds, but spread would still adopt any
        // future extra key (cancelled/status/syncBack). Clamp the duration
        // to the one-day learning bound like every other guest measurement.
        await this.commit(record, { state: "syncing_out", remoteStarted: true });
        const syncBack = await this.syncOutAfterTransport(record.identity.sandboxId, record.command!);
        const result: OffloadResult = { status: "completed", commandId: record.commandId, sandboxId: record.identity.sandboxId,
          warm: "cold" as OffloadWarm, queueWaitMs: 0, exitCode: raw.exitCode,
          seconds: Math.min(raw.seconds, MAX_DURATION_SECONDS), dollars: 0, ...(syncBack ? { syncBack } : {}) };
        await this.commit(record, { state: "completed", result, resultAt: this.now(), remoteStarted: true, fallbackSafe: false });
        await this.release(record);
        return result;
      }
      if (answer.kind === "not_started") {
        const result = this.unavailable(record, "verified durable guest never-started fence");
        await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
        await this.release(record);
        return result;
      }
      if (answer.kind === "started") {
        await this.commit(record, { state: "running", remoteStarted: true, fallbackSafe: false });
        return this.unknown(record);
      }
    }
    const result = this.unknown(record);
    await this.commit(record, { state: "unknown", result, resultAt: null, remoteStarted: null, fallbackSafe: false });
    return result;
  }

  async appendOutput(command: OffloadCommand, stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void> {
    if (!["stdout", "stderr"].includes(stream) || !(bytes instanceof Uint8Array)) throw offloadError("OFFLOAD_INVALID_OUTPUT");
    if (bytes.byteLength > OUTPUT_LIMIT_BYTES) throw offloadError("OFFLOAD_OUTPUT_LIMIT");
    const data = Buffer.from(bytes); // Snapshot before awaiting the record fence.
    const record = this.active.get(commandKey(command));
    if (!record) throw offloadError("OFFLOAD_COMMAND_NOT_RUNNING");
    await this.transition(record, async () => {
      if (!["starting", "running"].includes(record.state)) throw offloadError("OFFLOAD_COMMAND_NOT_RUNNING");
      const output = [...(record.output ?? [])];
      const retained = output.reduce((total, event) => total + Buffer.byteLength(event.dataBase64, "base64"), 0);
      if (retained + data.length > OUTPUT_LIMIT_BYTES
        || output.length + Math.ceil(data.length / 1024) > OUTPUT_LIMIT_EVENTS) throw offloadError("OFFLOAD_OUTPUT_LIMIT");
      // Bound metadata too: tiny writes must not create millions of immutable
      // events underneath the byte limit. Event cursors never change afterward.
      // Small events permit bounded reads even for large writes or invalid UTF-8.
      for (let at = 0; at < data.length; at += 1024) {
        output.push({ seq: output.length + 1, stream, dataBase64: data.subarray(at, at + 1024).toString("base64") });
      }
      await this.commit(record, { output });
    });
  }

  async readOutput(companyId: string, runId: string, commandId: string, after = 0, limitBytes = 65_536): Promise<OffloadReadView> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw offloadError("OFFLOAD_INVALID_REQUEST");
    }
    await this.checkRun(companyId, runId);
    const key = commandKey({ companyId, runId, commandId });
    const record = parseRecord(await this.deps.journalStore.get(key), key);
    this.checkExpiry(record);
    const events: OffloadOutputEvent[] = [];
    let remaining = Math.min(limitBytes, 65_536);
    for (const event of record.output ?? []) {
      if (event.seq <= after) continue;
      const size = Buffer.from(event.dataBase64, "base64").length;
      if (size > remaining) {
        if (!events.length) throw offloadError("OFFLOAD_OUTPUT_READ_TOO_SMALL");
        break;
      }
      events.push(structuredClone(event));
      remaining -= size;
    }
    return { ...this.view(record), events, nextCursor: events.at(-1)?.seq ?? after };
  }

  private checkExpiry(record: OffloadRecord): void {
    if (record.tombstone || (TERMINAL.has(record.state) && record.resultAt !== null && this.now() - record.resultAt >= DAY)) {
      throw offloadError("OFFLOAD_RESULT_EXPIRED");
    }
  }

  async readCommand(companyId: string, runId: string, commandId: string): Promise<OffloadCommandView> {
    await this.checkRun(companyId, runId);
    const key = commandKey({ companyId, runId, commandId });
    const record = parseRecord(await this.deps.journalStore.get(key), key);
    this.checkExpiry(record);
    return this.view(record);
  }

  private view(record: OffloadRecord): OffloadCommandView {
    const result = (record.state === "completed" || record.state === "cancelled") && record.result && "exitCode" in record.result ? {
      exitCode: record.result.exitCode, signal: null,
      timedOut: record.result.status === "completed" && record.result.timedOut === true,
      cancelled: record.state === "cancelled",
      syncBack: record.result.status === "completed" && record.result.syncBack
        ? structuredClone(record.result.syncBack) : { state: "clean" as const, changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null,
    } : null;
    // A never-started record's unavailable result names the admission gate
    // (queue, cap, quarantine…); surface it bounded so a local fallback can
    // say which one refused instead of a generic "never started".
    const fallbackReason = record.state === "not_started" && record.result?.status === "unavailable"
      ? record.result.reason.slice(0, 256) : null;
    return { version: 1, commandId: record.commandId, state: record.state,
      remoteStarted: record.remoteStarted, fallbackSafe: record.fallbackSafe,
      ...(fallbackReason !== null ? { fallbackReason } : {}), result };
  }

  async heartbeatCommand(companyId: string, runId: string, commandId: string, generation?: number): Promise<OffloadCommandView> {
    await this.checkRun(companyId, runId);
    const key = commandKey({ companyId, runId, commandId });
    const record = this.active.get(key) ?? parseRecord(await this.deps.journalStore.get(key), key);
    await this.transition(record, async () => {
      await this.refresh(record);
      const identity = record.identity;
      if (!this.lifecycle || record.cancelRequested || !identity?.heartbeatDeadline || !["starting", "running"].includes(record.state)
        || (generation !== undefined && generation !== identity.journalGeneration)
        || this.now() >= identity.heartbeatDeadline || this.now() >= identity.guestDeadline!) return;
      const renewed = { ...identity, heartbeatDeadline: this.now() + 30_000 };
      await this.commit(record, { identity: renewed });
      await this.lifecycle.heartbeat(renewed);
    });
    return this.view(record);
  }

  async cancelCommand(companyId: string, runId: string, commandId: string, reason: string, generation?: number): Promise<OffloadCommandView> {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 256) throw offloadError("OFFLOAD_INVALID_REQUEST");
    await this.checkRun(companyId, runId);
    await this.recover();
    const key = commandKey({ companyId, runId, commandId });
    const snapshot = this.active.get(key) ?? parseRecord(await this.deps.journalStore.get(key), key);
    const outcome = await this.transition(snapshot, async () => {
      // Re-resolve inside the fence: the pre-fence snapshot may predate a live
      // execution object holding the same key. Prefer the live object so the
      // fence arbitrates on one record; otherwise refresh the snapshot from
      // durable state so a stale read can neither clobber a later state nor
      // report fallbackSafe for a command that already ran. Cancellation only
      // ever moves a record forward from a pre-start state to not_started.
      const record = this.active.get(key) ?? snapshot;
      if (record === snapshot) await this.refresh(record);
      const current = generation === undefined || generation === (record.identity?.journalGeneration ?? 1);
      if (current && PRE_START.has(record.state)) {
        if (this.lifecycle && record.state === "syncing_in" && this.active.has(key)) {
          // Fence spawn now, but do not authorize a local fallback while push
          // may still be reading the workspace. run()/finish() settle the
          // never-started receipt only after the asynchronous phase unwinds.
          await this.commit(record, { cancelRequested: record.cancelRequested ?? reason });
        } else {
          const result = this.unavailable(record, "cancelled before durable starting intent");
          await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
        }
      }
      if (current && this.lifecycle && record.identity && !TERMINAL.has(record.state) && !record.cancelRequested) {
        await this.commit(record, { cancelRequested: reason });
      }
      return { view: this.view(record), command: record.command, result: record.result,
        identity: current && !TERMINAL.has(record.state) ? record.identity : null };
    });
    // Queue capacity/VM ownership is released only after the refusal commit,
    // outside the record fence so pool and journal locks cannot invert.
    if (outcome.view.state === "not_started" && outcome.command && outcome.result) await this.pool.cancel(outcome.command, outcome.result);
    if (outcome.identity) await this.lifecycle?.cancel(outcome.identity, reason);
    return outcome.view;
  }

  async collectGarbage(): Promise<void> {
    await this.serialize(async () => {
      for (const key of await this.deps.journalStore.list("command/")) {
        if (this.inFlight.has(key)) continue;
        const record = parseRecord(await this.deps.journalStore.get(key), key);
        if (!TERMINAL.has(record.state)) continue;
        const run = await this.deps.resolveRunState(record.companyId, record.runId);
        if (record.tombstone) {
          const terminatedAt = run.permanentlyTerminal ? run.terminatedAt ?? record.runTerminalSeenAt ?? null : null;
          if (terminatedAt !== null && this.now() >= terminatedAt + 30 * DAY && this.now() >= run.tokenExpiresAt) {
            await this.deps.journalStore.delete(key);
          } else if (run.permanentlyTerminal && run.terminatedAt === null && record.runTerminalSeenAt === undefined) {
            await this.deps.journalStore.set(key, { ...record, runTerminalSeenAt: this.now() });
          } else if (!run.permanentlyTerminal && record.runTerminalSeenAt !== undefined) {
            // The run is live again: its retention clock restarts once it ends.
            const { runTerminalSeenAt: _seen, ...live } = record;
            await this.deps.journalStore.set(key, live);
          }
        } else if (record.resultAt !== null && this.now() - record.resultAt >= DAY) {
          const { command: _command, output: _output, ...compact } = record;
          await this.deps.journalStore.set(key, { ...compact, result: null, tombstone: true,
            ...(run.permanentlyTerminal && run.terminatedAt === null ? { runTerminalSeenAt: this.now() } : {}) });
        }
      }
    });
  }
}
