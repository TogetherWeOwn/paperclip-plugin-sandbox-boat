// Offload command broker: journal, incremental output, heartbeat and cancel.
// Design: docs/adr/0001-heavy-command-offload.md. Routes delegate here after
// host authentication; the shim polls here. Remote execution itself is an
// injected OffloadBackend (the TOG-38024 executor grows start/cancel/streaming
// in a follow-up; until then the plugin wires a backend that never dispatches).
//
// Durability: the journal lives in the injected store (plugin state in prod),
// so a submit is never replayed after a crash. Backend handles are process
// local: after a restart a live command reads as `unknown` (a hold, never
// permission to replay) until the executor follow-up reconciles the guest.

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
}

/** Read-like calls bind only company + run; the journal holds the rest. */
export interface BrokerAuth {
  companyId: string;
  runId: string;
}

/** Placeholder backend until the TOG-38024 executor grows start/cancel. */
export class NeverDispatchBackend implements OffloadBackend {
  start(): OffloadBackendHandle {
    throw new Error("OFFLOAD_UNAVAILABLE: remote execution is not wired yet; the broker journals not_started and the shim falls back.");
  }
}

export interface OffloadJournalStore {
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

export interface OffloadBackendHandle {
  readonly done: Promise<void>;
  cancel(): Promise<void>;
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
}

const TERMINAL: ReadonlySet<OffloadCommandState> = new Set(["completed", "not_started", "cancelled", "failed"]);
const cmdKey = (commandId: string) => `offload.cmd.${commandId}`;
const countKey = (runId: string) => `offload.run.${runId}.count`;
const tombKey = (commandId: string) => `offload.tomb.${commandId}`;

function digestOf(request: OffloadSubmitRequest): string {
  return JSON.stringify({
    ws: request.executionWorkspaceId,
    cwd: request.cwdRelative,
    argv: request.argv,
    env: request.env,
    q: request.queueTimeoutMs,
    t: request.timeoutMs,
  });
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
  async recordRefusal(request: OffloadSubmitRequest, principal: BrokerPrincipal, _reason: string): Promise<void> {
    await this.chain(`run:${principal.runId}`, async () => {
      const digest = digestOf(request);
      const existing = await this.load(request.commandId);
      if (existing) {
        if (existing.digest !== digest) {
          throw Object.assign(new Error(`OFFLOAD_IDEMPOTENCY_CONFLICT: commandId ${request.commandId} was already accepted with a different payload.`), { code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
        }
        return;
      }
      const count = ((await this.store.get(countKey(principal.runId))) as number | null) ?? 0;
      if (count >= OFFLOAD_BOUNDS.maxCommandsPerRun) return;
      const now = this.now();
      await this.save({
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
        events: [],
        outputBytes: 0,
        result: null,
        terminalError: null,
        heartbeatDeadline: now + OFFLOAD_BOUNDS.heartbeatExpiryMs,
        commandDeadline: now + request.timeoutMs,
        createdAt: now,
        terminalAt: now,
      });
      await this.store.set(countKey(principal.runId), count + 1);
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
      const tomb: Tombstone = { commandId, runId: record.runId, digest: record.digest, outcome: record.state };
      await this.store.set(tombKey(commandId), tomb);
      await this.store.delete(cmdKey(commandId));
      this.handles.delete(commandId);
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

  private trackLive(record: JournalRecord): void {
    if (TERMINAL.has(record.state) || record.state === "unknown") this.known.delete(record.commandId);
    else this.known.add(record.commandId);
  }

  async submit(request: OffloadSubmitRequest, principal: BrokerPrincipal): Promise<BrokerResponse> {
    // Serialized per run so the 512-command admission bound cannot race.
    return this.chain(`run:${principal.runId}`, async () => {
      const digest = digestOf(request);
      const existing = await this.load(request.commandId);
      if (existing) {
        if (existing.digest !== digest) {
          return { status: 409, body: offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "commandId already used with a different payload", { commandId: request.commandId }) };
        }
        if (existing.companyId !== principal.companyId || existing.runId !== principal.runId) {
          return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "command belongs to another run", { commandId: request.commandId }) };
        }
        this.trackLive(existing);
        return { status: 200, body: this.view(existing, 0, OFFLOAD_BOUNDS.readLimitBytes) };
      }
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
        events: [],
        outputBytes: 0,
        result: null,
        terminalError: null,
        heartbeatDeadline: now + OFFLOAD_BOUNDS.heartbeatExpiryMs,
        commandDeadline: now + request.timeoutMs,
        createdAt: now,
        terminalAt: null,
      };
      // Persist intent before any external effect.
      await this.save(record);
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
        record.terminalAt = this.now();
        await this.save(record);
      }
      return this.accepted(record);
    });
  }

  async read(commandId: string, principal: BrokerAuth, after: number, limitBytes: number = OFFLOAD_BOUNDS.readLimitBytes): Promise<BrokerResponse> {
    return this.chain(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      return { status: 200, body: this.view(resolved, Math.max(0, after), Math.max(1, limitBytes)) };
    });
  }

  async heartbeat(commandId: string, principal: BrokerAuth): Promise<BrokerResponse> {
    // Worker-owned expiry rides on client heartbeats (every 5 s while any
    // client is alive); the sweep stays the slower crash backstop.
    await this.sweepExcept(commandId, this.now());
    // Renew from a fresh clock: a slow sweep must not hand back a deadline
    // that is already stale.
    const at = this.now();
    return this.chain(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      if (!TERMINAL.has(resolved.state) && resolved.state !== "unknown") {
        if (at >= resolved.commandDeadline) {
          await this.expireLoaded(resolved, at, true);
        } else {
          resolved.heartbeatDeadline = at + OFFLOAD_BOUNDS.heartbeatExpiryMs;
          await this.save(resolved);
        }
      }
      return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
    });
  }

  async cancel(commandId: string, principal: BrokerAuth, _reason: string): Promise<BrokerResponse> {
    const at = this.now();
    return this.chain(`cmd:${commandId}`, async () => {
      const resolved = await this.resolve(commandId, principal);
      if (!isRecord(resolved)) return resolved;
      if (TERMINAL.has(resolved.state) || resolved.state === "unknown") {
        return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
      }
      const handle = this.handles.get(commandId);
      if (handle) {
        try {
          await handle.cancel();
        } catch {
          // Cancel outcome uncertain: hold for reconciliation, never replay.
          resolved.state = "unknown";
          await this.save(resolved);
          return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
        }
        this.handles.delete(commandId);
      }
      if (!resolved.remoteStarted) {
        resolved.state = "not_started";
        resolved.fallbackSafe = true;
        resolved.result = null;
      } else {
        resolved.state = "cancelled";
        resolved.result = {
          exitCode: 143,
          signal: 15,
          timedOut: false,
          cancelled: true,
          syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null },
          usageRecordId: null,
        };
      }
      resolved.terminalAt = at;
      await this.save(resolved);
      return { status: 200, body: this.view(resolved, 0, OFFLOAD_BOUNDS.readLimitBytes) };
    });
  }

  /** Expire one loaded live record through the cancel path. Caller holds the command chain. */
  private async expireLoaded(record: JournalRecord, now: number, timedOut: boolean): Promise<void> {
    const handle = this.handles.get(record.commandId);
    if (handle) {
      try {
        await handle.cancel();
      } catch {
        record.state = "unknown";
        await this.save(record);
        return;
      }
      this.handles.delete(record.commandId);
    }
    if (!record.remoteStarted) {
      record.state = "not_started";
      record.fallbackSafe = true;
      record.result = null;
    } else {
      record.state = "cancelled";
      record.result = {
        exitCode: 143,
        signal: 15,
        timedOut,
        cancelled: true,
        syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null },
        usageRecordId: null,
      };
    }
    record.terminalAt = now;
    await this.save(record);
  }

  private async sweepExcept(exceptId: string | null, now: number): Promise<void> {
    for (const commandId of [...this.known]) {
      if (commandId === exceptId) continue;
      await this.chain(`cmd:${commandId}`, async () => {
        const record = await this.load(commandId);
        if (!record || TERMINAL.has(record.state) || record.state === "unknown") {
          this.known.delete(commandId);
          return;
        }
        const timedOut = now >= record.commandDeadline;
        if (now < record.heartbeatDeadline && !timedOut) return;
        await this.expireLoaded(record, now, timedOut);
      });
    }
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
          record.state = "completed";
          record.result = {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            cancelled: false,
            syncBack: result.syncBack,
            usageRecordId: result.usageRecordId ?? null,
          };
          record.terminalAt = at;
          this.handles.delete(commandId);
          return { save: true };
        });
      },
      failToStart: (_reason) => {
        const at = this.now();
        mutate((record) => {
          if (record.remoteStarted) {
            record.state = "unknown";
            return { save: true };
          }
          record.state = "not_started";
          record.fallbackSafe = true;
          record.terminalAt = at;
          this.handles.delete(commandId);
          return { save: true };
        });
      },
      fail: (_error) => {
        const at = this.now();
        mutate((record) => {
          record.state = "failed";
          record.terminalAt = at;
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
