// Offload command broker: journal, incremental output, heartbeat and cancel.
// Design: docs/design/adr/0001-heavy-command-offload.md. Routes delegate here after
// host authentication; the shim polls here. Remote execution itself is an
// injected OffloadBackend; the executor adapter is explicitly opt-in. Without
// an installed lifecycle executor, the plugin never dispatches.
//
// Durability: the journal lives in the injected store (plugin state in prod),
// so a submit is never replayed after a crash. Backend handles are process
// local: after a restart a live command reads as `unknown` (a hold, never
// permission to replay) until the executor follow-up reconciles the guest.

import { runOutsideInvocation } from "../proactive.js";
import { offloadError } from "./errors.js";
import {
  OFFLOAD_BOUNDS,
  OFFLOAD_VERSION,
  type OffloadCommandState,
  type OffloadErrorCode,
  type OffloadOutputEvent,
  type OffloadReadResponse,
  type OffloadSubmitAccepted,
  type OffloadSubmitRequest,
  type OffloadSyncBack,
  type OffloadTerminalResult,
} from "./protocol.js";

export interface BrokerPrincipal {
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  /** Host-resolved pool trust domain; the executor never reuses a VM across domains. */
  trustDomainId?: string;
}

/** Read-like calls bind only company + run; the journal holds the rest. */
export interface BrokerAuth {
  companyId: string;
  runId: string;
}

/**
 * A pre-start refusal that names its gate. Executor resolution returns this
 * instead of a bare null so the specific reason reaches the journal, the read
 * view and the shim's local-fallback notice instead of being discarded.
 */
export interface ExecutorRefusal {
  refusalReason: string;
}

export function isExecutorRefusal(value: unknown): value is ExecutorRefusal {
  return typeof value === "object" && value !== null
    && typeof (value as ExecutorRefusal).refusalReason === "string";
}

/** Placeholder backend until the executor follow-up grows start/cancel. */
export class NeverDispatchBackend implements OffloadBackend {
  start(): OffloadBackendHandle {
    throw new Error("OFFLOAD_UNAVAILABLE: remote execution is not wired yet; the broker journals not_started and the shim falls back.");
  }
}

export interface OffloadJournalStore {
  /** Host atomic insertion prevents a racing refusal overwriting an admission. */
  create?(key: string, value: unknown): Promise<boolean>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BackendCommand {
  commandId: string;
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  /** Absent means cargo; the route layer fills it before submit. */
  tool?: "cargo" | "node" | "python";
  /** Package runner / test binary, e.g. npm, pytest. Absent means cargo. */
  runner?: string;
  executionWorkspaceId: string;
  /** Host-resolved pool trust domain (see BrokerPrincipal). */
  trustDomainId?: string;
  cwdRelative: string;
  argv: string[];
  env: Record<string, string>;
  queueTimeoutMs: number;
  timeoutMs: number;
}

export interface BackendCompletion {
  exitCode: number;
  signal: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  syncBack: OffloadSyncBack;
  usageRecordId?: string | null;
}

export interface OffloadOutputSink {
  started(): void;
  write(stream: "stdout" | "stderr", data: Uint8Array): void;
  complete(result: BackendCompletion): void;
  failToStart(reason: string): void;
  fail(error: Error): void;
}

/** Authoritative cancellation receipt, including sync settlement. Legacy test
 * backends may return void; lifecycle executors must return actual evidence. */
export type BackendCancellation =
  | { state: "not_started"; remoteStarted: false; fallbackSafe: true; result: null }
  | { state: "completed" | "cancelled"; remoteStarted: true; fallbackSafe: false; result: BackendCompletion };

export interface OffloadBackendHandle {
  readonly done: Promise<void>;
  cancel(): Promise<void | BackendCancellation>;
  heartbeat?(): Promise<void>;
}

export interface OffloadBackend {
  start(cmd: BackendCommand, sink: OffloadOutputSink): OffloadBackendHandle;
}

export interface BrokerResponse {
  status: number;
  body: unknown;
}

interface JournalRecord {
  version: 1;
  commandId: string;
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  digest: string;
  state: OffloadCommandState;
  remoteStarted: boolean;
  fallbackSafe: boolean;
  /** Site-specific pre-start refusal reason; absent on records written before it existed. */
  fallbackReason?: string | null;
  events: OffloadOutputEvent[];
  outputBytes: number;
  result: OffloadTerminalResult | null;
  terminalError: OffloadErrorCode | null;
  heartbeatDeadline: number;
  commandDeadline: number;
  createdAt: number;
  terminalAt: number | null;
}

interface Tombstone {
  commandId: string;
  runId: string;
  digest: string;
  outcome: OffloadCommandState;
  /** Absent on tombstones written before retention: the sweep stamps one. */
  expiresAt?: number;
}

/** Every command and run this broker journaled, so retention can enumerate keys the store cannot list. */
interface RetentionIndex {
  version: 1;
  commands: Record<string, string>;
  runs: Record<string, number>;
}

const TERMINAL: ReadonlySet<OffloadCommandState> = new Set(["completed", "not_started", "cancelled", "failed"]);
const cmdKey = (commandId: string) => `offload.cmd.${commandId}`;
const countKey = (runId: string) => `offload.run.${runId}.count`;
const tombKey = (commandId: string) => `offload.tomb.${commandId}`;
const INDEX_KEY = "offload.retention";
/** An expired commandId refuses reuse this long; a run's count outlives its last command by as much. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

function digestOf(request: OffloadSubmitRequest, canonicalEnv = true): string {
  return JSON.stringify({
    ws: request.executionWorkspaceId,
    cwd: request.cwdRelative,
    tool: request.tool ?? "cargo",
    runner: request.runner ?? "cargo",
    argv: request.argv,
    env: canonicalEnv ? Object.fromEntries(Object.entries(request.env).sort(([a], [b]) => a.localeCompare(b))) : request.env,
    q: request.queueTimeoutMs,
    t: request.timeoutMs,
  });
}

const DEFAULT_RUNNER: Readonly<Record<string, string>> = { node: "npm", python: "pytest" };

/**
 * Every digest that spells this same command. Journal rows written before the
 * route layer normalised an omitted Node/Python `runner` carry the broker's
 * old cargo default in their digest; the same body after that change digests
 * with npm/pytest. Both spellings mean the tool's default runner — an explicit
 * cargo runner is rejected upstream for Node/Python profiles, so a cargo
 * digest there can only mean "omitted". New rows keep the primary (normalised)
 * digest; the legacy spelling is accepted only when matching an existing row.
 */
function acceptedDigests(request: OffloadSubmitRequest): string[] {
  const variants = [request];
  const fallback = DEFAULT_RUNNER[request.tool ?? "cargo"];
  const runner = request.runner ?? "cargo";
  if (fallback && (runner === fallback || runner === "cargo")) {
    variants.push({ ...request, runner: runner === fallback ? "cargo" : fallback });
  }
  // New rows sort env keys; preserve matching pre-canonicalisation receipts.
  return [...new Set(variants.flatMap((variant) => [digestOf(variant), digestOf(variant, false)]))];
}

export interface OffloadBrokerDeps {
  store: OffloadJournalStore;
  backend: OffloadBackend;
  now: () => number;
}

export class OffloadBroker {
  private readonly store: OffloadJournalStore;
  private readonly backend: OffloadBackend;
  private readonly now: () => number;
  private readonly handles = new Map<string, OffloadBackendHandle>();
  /** Live (non-terminal) commands only; swept on every heartbeat. */
  private readonly known = new Set<string>();
  /** Commands whose sink journal write failed: their persisted state is untrustworthy. */
  private readonly poisoned = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly expiryCancellations = new Map<string, Promise<void>>();

  constructor(deps: OffloadBrokerDeps) {
    this.store = deps.store;
    this.backend = deps.backend;
    this.now = deps.now;
  }

  /** Serialize every store access per key: sink callbacks are sync fire-and-forget. */
  private chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }

  private async load(commandId: string): Promise<JournalRecord | null> {
    const raw = await this.store.get(cmdKey(commandId));
    const record = (raw ?? null) as JournalRecord | null;
    if (record && this.poisoned.has(commandId) && record.state !== "unknown") {
      // A lost sink write may hide a start or output: hold for reconciliation,
      // never offer the local fallback.
      record.state = "unknown";
      record.fallbackSafe = false;
    }
    return record;
  }

  private async save(record: JournalRecord): Promise<void> {
    await this.store.set(cmdKey(record.commandId), record);
  }

  private async insert(record: JournalRecord, digests: string[]): Promise<BrokerResponse | null> {
    // Production new-admission routes require this negotiated host capability.
    // Legacy standalone broker fixtures retain their single-worker store port.
    if (!this.store.create) { await this.save(record); return null; }
    if (await this.store.create(cmdKey(record.commandId), record) === true) return null;
    const raced = await this.load(record.commandId);
    return raced ? this.existingResponse(raced, digests, record) : {
      status: 409, body: offloadError("OFFLOAD_EXECUTION_UNKNOWN", "command journal insertion was not confirmed; never replay", {
        commandId: record.commandId, remoteStarted: null, fallbackSafe: false,
      }),
    };
  }

  private view(record: JournalRecord, after: number, limitBytes: number): OffloadReadResponse {
    const events: OffloadOutputEvent[] = [];
    let bytes = 0;
    for (const event of record.events) {
      if (event.seq < after) continue;
      const size = event.dataBase64.length;
      if (events.length > 0 && bytes + size > limitBytes) break;
      events.push(event);
      bytes += size;
    }
    const nextCursor = events.length > 0 ? events[events.length - 1]!.seq + 1 : after;
    return {
      version: OFFLOAD_VERSION,
      commandId: record.commandId,
      state: record.state,
      remoteStarted: record.remoteStarted,
      fallbackSafe: record.fallbackSafe,
      fallbackReason: record.fallbackReason ?? null,
      events,
      nextCursor,
      result: record.result,
      terminalError: record.terminalError,
    };
  }

  private accepted(record: JournalRecord): BrokerResponse {
    const body: OffloadSubmitAccepted = {
      version: OFFLOAD_VERSION,
      commandId: record.commandId,
      state: "queued",
      remoteStarted: false,
      fallbackSafe: false,
      eventsCursor: 0,
    };
    return { status: 202, body };
  }

  /**
   * Journal a deterministic pre-acceptance refusal (incompatible workload,
   * unsupported confinement) as a terminal never-started receipt, so a future
   * dispatch of the same ID is impossible. Counts toward the per-run bound;
   * past the bound the refusal still stands, deterministically, without a
   * receipt. Never starts the backend.
   */
  /**
   * Journal a deterministic never-started refusal. Returns null when this
   * call journaled (or the journal is full, so nothing can be claimed). When
   * the journal already knows the ID — a concurrent acceptance won the race
   * with the caller's pre-check — returns that record's verdict instead, so
   * the caller never answers fallback-safe over a started command.
   */
  async recordRefusal(request: OffloadSubmitRequest, principal: BrokerPrincipal, reason: string): Promise<BrokerResponse | null> {
    return this.chain(`run:${principal.runId}`, async () => {
      const digests = acceptedDigests(request);
      const digest = digests[0];
      const existing = await this.load(request.commandId);
      if (existing) {
        if (!digests.includes(existing.digest)) {
          throw Object.assign(new Error(`OFFLOAD_IDEMPOTENCY_CONFLICT: commandId ${request.commandId} was already accepted with a different payload.`), { code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
        }
        return this.existingResponse(existing, digests, principal);
      }
      const count = ((await this.store.get(countKey(principal.runId))) as number | null) ?? 0;
      if (count >= OFFLOAD_BOUNDS.maxCommandsPerRun) return null;
      const now = this.now();
      // Index first: a failed index write leaves no record, and an indexed
      // command without a record is simply pruned by the sweep.
      await this.track(request.commandId, principal.runId, now);
      const raced = await this.insert({
        version: 1,
        commandId: request.commandId,
        companyId: principal.companyId,
        runId: principal.runId,
        cardId: principal.cardId,
        repoId: principal.repoId,
        profileId: principal.profileId,
        digest,
        state: "not_started",
        remoteStarted: false,
        fallbackSafe: true,
        // Same 256-char bound failToStart applies: a classification reason can
        // embed argv-derived names, and the journal must not persist or serve
        // an unbounded caller-influenced string on every read.
        fallbackReason: reason.slice(0, 256),
        events: [],
        outputBytes: 0,
        result: null,
        terminalError: null,
        heartbeatDeadline: now + OFFLOAD_BOUNDS.heartbeatExpiryMs,
        commandDeadline: now + request.timeoutMs,
        createdAt: now,
        terminalAt: now,
      }, digests);
      if (raced) return raced;
      await this.store.set(countKey(principal.runId), count + 1);
      return null;
    });
  }

  /** Resolve a command for read-like calls: guards, expiry, restart hold. */
  private async resolve(commandId: string, principal: BrokerAuth): Promise<JournalRecord | BrokerResponse> {
    const record = await this.load(commandId);
    if (!record) {
      const tomb = (await this.store.get(tombKey(commandId))) as Tombstone | null;
      if (tomb) {
        return { status: 410, body: offloadError("OFFLOAD_RESULT_EXPIRED", "result retention elapsed", { commandId, remoteStarted: null }) };
      }
      return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "unknown commandId", { commandId }) };
    }
    if (record.companyId !== principal.companyId || record.runId !== principal.runId) {
      return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "command belongs to another run", { commandId }) };
    }
    if (TERMINAL.has(record.state) && record.terminalAt !== null && record.terminalAt + OFFLOAD_BOUNDS.resultRetentionMs < this.now()) {
      await this.expire(record);
      return { status: 410, body: offloadError("OFFLOAD_RESULT_EXPIRED", "result retention elapsed", { commandId, remoteStarted: record.remoteStarted }) };
    }
    // Never expire an unresolved command; a missing handle after a restart is
    // a reconciliation hold, not permission to replay or to drop.
    if (!TERMINAL.has(record.state) && record.state !== "unknown" && !this.handles.has(commandId)) {
      record.state = "unknown";
      await this.save(record);
    }
    this.trackLive(record);
    return record;
  }

  /** Replace a retention-elapsed terminal record with its bounded tombstone. */
  private async expire(record: JournalRecord): Promise<void> {
    const tomb: Tombstone = { commandId: record.commandId, runId: record.runId, digest: record.digest, outcome: record.state,
      expiresAt: this.now() + TOMBSTONE_RETENTION_MS };
    await this.store.set(tombKey(record.commandId), tomb);
    await this.store.delete(cmdKey(record.commandId));
    this.handles.delete(record.commandId);
  }

  private async readIndex(): Promise<RetentionIndex> {
    const raw = (await this.store.get(INDEX_KEY)) as RetentionIndex | null;
    return raw && raw.version === 1 ? raw : { version: 1, commands: {}, runs: {} };
  }

  private async track(commandId: string, runId: string, at: number): Promise<void> {
    await this.chain(INDEX_KEY, async () => {
      const index = await this.readIndex();
      index.commands[commandId] = runId;
      index.runs[runId] = Math.max(index.runs[runId] ?? 0, at);
      await this.store.set(INDEX_KEY, index);
    });
  }

  /**
   * Retention sweep: tombstone terminal records past result retention even if
   * never read again, delete tombstones past their own retention, and drop a
   * run's command count once none of its commands remain and the run has been
   * idle for the tombstone window. Unresolved commands are never touched.
   */
  async collectGarbage(): Promise<void> {
    const index = await this.chain(INDEX_KEY, () => this.readIndex());
    for (const [commandId, runId] of Object.entries(index.commands)) {
      await this.chain(`run:${runId}`, () => this.chain(`cmd:${commandId}`, async () => {
        const now = this.now();
        const record = await this.load(commandId);
        if (record) {
          if (TERMINAL.has(record.state) && record.terminalAt !== null && record.terminalAt + OFFLOAD_BOUNDS.resultRetentionMs < now) {
            await this.expire(record);
          }
          return;
        }
        const tomb = (await this.store.get(tombKey(commandId))) as Tombstone | null;
        if (tomb && typeof tomb.expiresAt !== "number") {
          await this.store.set(tombKey(commandId), { ...tomb, expiresAt: now + TOMBSTONE_RETENTION_MS });
          return;
        }
        if (tomb && now < tomb.expiresAt!) return;
        if (tomb) await this.store.delete(tombKey(commandId));
        // Unindex under the run lock: a retried submit of this ID re-tracks it
        // only after, never between this check and the prune.
        await this.chain(INDEX_KEY, async () => {
          const current = await this.readIndex();
          delete current.commands[commandId];
          await this.store.set(INDEX_KEY, current);
        });
      }));
    }
    await this.chain(INDEX_KEY, async () => {
      const current = await this.readIndex();
      const referenced = new Set(Object.values(current.commands));
      const now = this.now();
      for (const [runId, at] of Object.entries(current.runs)) {
        if (referenced.has(runId) || now < at + TOMBSTONE_RETENTION_MS) continue;
        await this.store.delete(countKey(runId));
        delete current.runs[runId];
      }
      await this.store.set(INDEX_KEY, current);
    });
  }

  private trackLive(record: JournalRecord): void {
    if (TERMINAL.has(record.state) || (record.state === "unknown" && !this.handles.has(record.commandId))) this.known.delete(record.commandId);
    else this.known.add(record.commandId);
  }

  private async existingResponse(existing: JournalRecord, digests: string[], principal: BrokerAuth): Promise<BrokerResponse> {
    if (!digests.includes(existing.digest)) {
      return { status: 409, body: offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "commandId already used with a different payload", { commandId: existing.commandId }) };
    }
    if (existing.companyId !== principal.companyId || existing.runId !== principal.runId) {
      return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "command belongs to another run", { commandId: existing.commandId }) };
    }
    // Same orphan hold as resolve(): after a restart a live record has no
    // handle, so hold for reconciliation instead of replaying live state
    // where a sweep could expire it into a fallback-safe receipt.
    if (!TERMINAL.has(existing.state) && existing.state !== "unknown" && !this.handles.has(existing.commandId)) {
      existing.state = "unknown";
      await this.save(existing);
    }
    this.trackLive(existing);
    return { status: 200, body: this.view(existing, 0, OFFLOAD_BOUNDS.readLimitBytes) };
  }

  /**
   * A pre-acceptance refusal must not claim a command never started when the
   * journal already knows that ID. A missing binding is not proof of a clean
   * ID: the workspace record can disappear after acceptance (for example when
   * a run's bindings are forgotten while its command is still remote). Return
   * the journal's verdict for a known ID, or null when this ID is still unused.
   * Nothing is journaled for an unknown ID.
   */
  async existingSubmission(request: OffloadSubmitRequest, principal: BrokerAuth): Promise<BrokerResponse | null> {
    return this.chain(`run:${principal.runId}`, async () => {
      const digests = acceptedDigests(request);
      const existing = await this.load(request.commandId);
      if (!existing) {
        const tomb = (await this.store.get(tombKey(request.commandId))) as Tombstone | null;
        if (tomb) {
          return { status: 410, body: offloadError("OFFLOAD_RESULT_EXPIRED", "commandId already expired; never remint an ID", { commandId: request.commandId }) };
        }
        return null;
      }
      return this.existingResponse(existing, digests, principal);
    });
  }

  async submit(request: OffloadSubmitRequest, principal: BrokerPrincipal, consume?: () => Promise<BrokerResponse | null>): Promise<BrokerResponse> {
    // Serialized per run so the 512-command admission bound cannot race.
    return this.chain(`run:${principal.runId}`, async () => {
      const digests = acceptedDigests(request);
      const digest = digests[0];
      const existing = await this.load(request.commandId);
      if (existing) return this.existingResponse(existing, digests, principal);
      const tomb = (await this.store.get(tombKey(request.commandId))) as Tombstone | null;
      if (tomb) {
        return { status: 410, body: offloadError("OFFLOAD_RESULT_EXPIRED", "commandId already expired; never remint an ID", { commandId: request.commandId }) };
      }
      const count = ((await this.store.get(countKey(principal.runId))) as number | null) ?? 0;
      if (count >= OFFLOAD_BOUNDS.maxCommandsPerRun) {
        return {
          status: 503,
          body: offloadError("OFFLOAD_UNAVAILABLE", "per-run command journal is full", { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
        };
      }
      // The route's durable company+run claim is the cross-worker boundary.
      // Existing receipts above never consume or re-dispatch. Losing a claim
      // race permits only an existing receipt, not fresh journal intent.
      if (consume) {
        const refused = await consume();
        if (refused) {
          const raced = await this.load(request.commandId);
          return raced ? this.existingResponse(raced, digests, principal) : refused;
        }
      }
      // now() is read inside the chain: submit is always awaited, so no caller
      // observes time between the call and the admission.
      const now = this.now();
      const record: JournalRecord = {
        version: 1,
        commandId: request.commandId,
        companyId: principal.companyId,
        runId: principal.runId,
        cardId: principal.cardId,
        repoId: principal.repoId,
        profileId: principal.profileId,
        digest,
        state: "queued",
        remoteStarted: false,
        fallbackSafe: false,
        fallbackReason: null,
        events: [],
        outputBytes: 0,
        result: null,
        terminalError: null,
        heartbeatDeadline: now + OFFLOAD_BOUNDS.heartbeatExpiryMs,
        commandDeadline: now + request.timeoutMs,
        createdAt: now,
        terminalAt: null,
      };
      // Persist intent before any external effect. Index first, as in
      // recordRefusal: an index failure must not strand an undispatched record.
      await this.track(request.commandId, principal.runId, now);
      const raced = await this.insert(record, digests);
      if (raced) return raced;
      await this.store.set(countKey(principal.runId), count + 1);
      this.known.add(request.commandId);

      const sink = this.sinkFor(request.commandId);
      try {
        const handle = this.backend.start(
          {
            commandId: request.commandId,
            companyId: principal.companyId,
            runId: principal.runId,
            cardId: principal.cardId,
            repoId: principal.repoId,
            profileId: principal.profileId,
            tool: request.tool ?? "cargo",
            runner: request.runner ?? "cargo",
            executionWorkspaceId: request.executionWorkspaceId,
            // Fail closed if a caller built a principal without a domain: the
            // workspace itself is the smallest safe domain.
            trustDomainId: principal.trustDomainId ?? `workspace:${request.executionWorkspaceId}`,
            cwdRelative: request.cwdRelative,
            argv: request.argv,
            env: request.env,
            queueTimeoutMs: request.queueTimeoutMs,
            timeoutMs: request.timeoutMs,
          },
          sink,
        );
        this.handles.set(request.commandId, handle);
      } catch {
        // The backend refused before any spawn: durable never-started receipt.
        record.state = "not_started";
        record.fallbackSafe = true;
        record.fallbackReason = "executor backend refused to start";
        record.terminalAt = this.now();
        await this.save(record);
      }
      return this.accepted(record);
    });
  }

  async read(commandId: string, principal: BrokerAuth, after: number, limitBytes: number = OFFLOAD_BOUNDS.readLimitBytes, request?: OffloadSubmitRequest): Promise<BrokerResponse> {
    return this.chain(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      // Receipt verification shares submit compatibility, after ownership is proven.
      if (request && !acceptedDigests(request).includes(resolved.digest)) {
        return { status: 409, body: offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "commandId already used with a different payload", { commandId }) };
      }
      return { status: 200, body: this.view(resolved, Math.max(0, after), Math.max(1, limitBytes)) };
    });
  }

  async heartbeat(commandId: string, principal: BrokerAuth): Promise<BrokerResponse> {
    // Worker-owned expiry rides on client heartbeats (every 5 s while any
    // client is alive); the sweep stays the slower crash backstop.
    await this.sweepExcept(commandId, this.now(), false);
    // Renew from a fresh clock: a slow sweep must not hand back a deadline
    // that is already stale.
    const at = this.now();
    const response = await this.chain(`cmd:${commandId}`, async (): Promise<BrokerResponse | null> => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      if (!TERMINAL.has(resolved.state) && resolved.state !== "unknown") {
        if (at >= resolved.commandDeadline) return null;
        try {
          await this.handles.get(commandId)?.heartbeat?.();
          resolved.heartbeatDeadline = at + OFFLOAD_BOUNDS.heartbeatExpiryMs;
        } catch {
          resolved.state = "unknown";
          resolved.fallbackSafe = false;
        }
        await this.save(resolved);
      }
      return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
    });
    return response ?? await this.cancelCommand(commandId, principal, at, true);
  }

  async cancel(commandId: string, principal: BrokerAuth, _reason: string): Promise<BrokerResponse> {
    return await this.cancelCommand(commandId, principal, this.now(), false);
  }

  private async cancelCommand(commandId: string, principal: BrokerAuth, now: number, timedOut: boolean): Promise<BrokerResponse> {
    const pending = await this.chain<{ response: BrokerResponse } | { handle: OffloadBackendHandle }>(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return { response: resolved };
      const handle = this.handles.get(commandId);
      // Unknown is a replay hold, not a reason to ignore a still-live handle.
      // After restart, missing handles remain unknown and never grant fallback.
      if (TERMINAL.has(resolved.state) || !handle) {
        return { response: { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) } };
      }
      return { handle };
    });
    if ("response" in pending) return pending.response;

    // Do not hold the journal chain while joining remote cancellation. The
    // adapter drains output before done settles; its sink callbacks must commit
    // before the cancellation receipt can make the broker record terminal.
    let receipt: BackendCancellation | void = undefined;
    let failed = false;
    try { receipt = await pending.handle.cancel(); }
    catch { failed = true; }

    return await this.chain(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      if (!TERMINAL.has(resolved.state)) {
        if (failed || this.poisoned.has(commandId)) {
          resolved.state = "unknown";
          resolved.fallbackSafe = false;
        } else {
          this.handles.delete(commandId);
          if (receipt) {
            resolved.state = receipt.state;
            resolved.remoteStarted = receipt.remoteStarted;
            resolved.fallbackSafe = receipt.fallbackSafe;
            resolved.result = receipt.result ? { ...receipt.result,
              cancelled: receipt.result.cancelled === true, usageRecordId: receipt.result.usageRecordId ?? null } : null;
          } else if (!resolved.remoteStarted) {
            resolved.state = "not_started";
            resolved.fallbackSafe = true;
            resolved.fallbackReason = "cancelled before the command started";
            resolved.result = null;
          } else {
            resolved.state = "cancelled";
            resolved.result = {
              exitCode: 143, signal: 15, timedOut, cancelled: true,
              syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null,
            };
          }
          resolved.terminalAt = now;
        }
        await this.save(resolved);
      }
      return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
    });
  }

  private async sweepExcept(exceptId: string | null, now: number, waitForSettlements = true): Promise<void> {
    const pending = new Set(this.expiryCancellations.values());
    for (const commandId of [...this.known]) {
      if (commandId === exceptId) continue;
      const expired = await this.chain(`cmd:${commandId}`, async () => {
        const record = await this.load(commandId);
        if (!record || TERMINAL.has(record.state) || (record.state === "unknown" && !this.handles.has(commandId))) {
          this.known.delete(commandId);
          return null;
        }
        if (now < record.heartbeatDeadline && now < record.commandDeadline) return null;
        return record;
      });
      if (expired) {
        let cancellation = this.expiryCancellations.get(commandId);
        if (!cancellation) {
          // The heartbeat may return before cancellation I/O settles. Detach
          // the whole operation, including its final broker journal update,
          // from that invocation; stores still bind the explicit company.
          cancellation = runOutsideInvocation(() =>
            this.cancelCommand(commandId, expired, now, now >= expired.commandDeadline))
            .then(() => undefined).finally(() => { this.expiryCancellations.delete(commandId); });
          this.expiryCancellations.set(commandId, cancellation);
          // Heartbeats must not join another command's sync/cleanup. Observe
          // detached failures; a later sweep can retry the still-owned command.
          void cancellation.catch(() => undefined);
        }
        pending.add(cancellation);
      }
    }
    if (waitForSettlements) await Promise.all(pending);
  }

  /**
   * Apply heartbeat expiry and command deadlines through the cancel path.
   * Iterates commands known to this worker; crash-backstop enumeration across
   * restarts belongs to the executor/sweep follow-up.
   */
  async checkExpirations(): Promise<void> {
    await this.sweepExcept(null, this.now());
  }

  private sinkFor(commandId: string): OffloadOutputSink {
    const mutate = (fn: (record: JournalRecord) => { save: boolean; after?: () => void }): void => {
      void this.chain(`cmd:${commandId}`, async () => {
        try {
          const record = await this.load(commandId);
          if (!record || TERMINAL.has(record.state)) return;
          // Later backend callbacks must not move a poisoned record: the
          // persisted unknown hold stands until the executor reconciles it.
          if (this.poisoned.has(commandId)) return;
          const { save, after } = fn(record);
          if (save) await this.save(record);
          after?.();
        } catch {
          // A lost journal write must not leave a stale remoteStarted=false or
          // a silently short output: flip to unknown (hold, never replay) and
          // stop the command so it cannot run unobserved.
          this.poisoned.add(commandId);
          this.known.delete(commandId);
          const handle = this.handles.get(commandId);
          this.handles.delete(commandId);
          if (handle) await handle.cancel().catch(() => undefined);
          try {
            const raw = (await this.store.get(cmdKey(commandId))) as JournalRecord | null;
            if (raw && !TERMINAL.has(raw.state)) {
              raw.state = "unknown";
              raw.fallbackSafe = false;
              await this.save(raw);
            }
          } catch {
            // The in-memory poison mark still holds the line until restart,
            // when the missing handle yields the same unknown hold.
          }
        }
      });
    };
    return {
      started: () => {
        mutate((record) => {
          record.state = "running";
          record.remoteStarted = true;
          return { save: true };
        });
      },
      write: (stream, data) => {
        const snapshot = Buffer.from(data);
        const at = this.now();
        mutate((record) => {
          if (record.outputBytes + snapshot.byteLength > OFFLOAD_BOUNDS.maxOutputBytes) {
            // Bound exhaustion: cancel and report, never silently truncate.
            record.state = "cancelled";
            record.terminalError = "OFFLOAD_OUTPUT_LIMIT";
            record.result = {
              exitCode: 143,
              signal: 15,
              timedOut: false,
              cancelled: true,
              syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null },
              usageRecordId: null,
            };
            record.terminalAt = at;
            const handle = this.handles.get(commandId);
            if (handle) {
              this.handles.delete(commandId);
              return { save: true, after: () => void handle.cancel().catch(() => undefined) };
            }
            return { save: true };
          }
          record.events.push({ seq: record.events.length, stream, dataBase64: snapshot.toString("base64") });
          record.outputBytes += snapshot.byteLength;
          return { save: true };
        });
      },
      complete: (result) => {
        // Event time is captured synchronously: the mutation runs later on the
        // chain, and fake-time tests may advance the clock in between.
        const at = this.now();
        mutate((record) => {
          record.state = result.cancelled ? "cancelled" : "completed";
          record.result = {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            cancelled: result.cancelled === true,
            syncBack: result.syncBack,
            usageRecordId: result.usageRecordId ?? null,
          };
          record.terminalAt = at;
          this.handles.delete(commandId);
          return { save: true };
        });
      },
      failToStart: (reason) => {
        const at = this.now();
        mutate((record) => {
          if (record.remoteStarted) {
            record.state = "unknown";
            return { save: true };
          }
          record.state = "not_started";
          record.fallbackSafe = true;
          // The refusing site's own words, bounded: the journal record is
          // persisted and the shim prints this verbatim on its notice line.
          record.fallbackReason = typeof reason === "string" && reason !== "" ? reason.slice(0, 256) : "executor refused before start";
          record.terminalAt = at;
          this.handles.delete(commandId);
          return { save: true };
        });
      },
      fail: (error) => {
        const at = this.now();
        mutate((record) => {
          record.state = (error as Error & { code?: string }).code === "OFFLOAD_EXECUTION_UNKNOWN" ? "unknown" : "failed";
          record.fallbackSafe = false;
          record.terminalAt = record.state === "unknown" ? null : at;
          this.handles.delete(commandId);
          return { save: true };
        });
      },
    };
  }
}

function isRecord(value: JournalRecord | BrokerResponse): value is JournalRecord {
  return (value as JournalRecord).commandId !== undefined && (value as BrokerResponse).status === undefined;
}
