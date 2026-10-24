// Durable command evidence, independent of provider and transport implementations.
import { createHash, randomUUID } from "node:crypto";
import type { OffloadCommand, OffloadResult, OffloadWarm } from "./offload.js";

export interface OffloadStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  create(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface OffloadIdentity {
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
  tombstone?: boolean;
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
  collect(sandboxId: string, command: OffloadCommand): Promise<void>;
  stage(sandboxId: string, command: OffloadCommand): Promise<void>;
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
  result: {
    exitCode: number;
    signal: null;
    timedOut: boolean;
    cancelled: boolean;
    syncBack: { state: "clean"; changedPaths: string[]; conflictPaths: string[]; artifactId: null };
    usageRecordId: null;
  } | null;
}

const DAY = 86_400_000;
const TERMINAL = new Set<OffloadState>(["completed", "not_started", "cancelled", "failed"]);
const PRE_START = new Set<OffloadState>(["accepted", "queued", "syncing_in"]);
const STATES = new Set<OffloadState>([...TERMINAL, ...PRE_START, "starting", "running", "syncing_out", "unknown"]);
export const offloadError = (code: string) => Object.assign(new Error(code), { code });

export function commandDigest(command: OffloadCommand): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
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
export function validIdentity(value: unknown): value is OffloadIdentity {
  return object(value) && ["companyId", "runId", "commandId", "digest", "sandboxId", "guestBootId"]
    .every((key) => typeof value[key] === "string" && value[key].length > 0)
    && Number.isSafeInteger(value.journalGeneration) && (value.journalGeneration as number) > 0;
}
export function matchingReceipt(value: unknown, identity: OffloadIdentity): value is OffloadReceipt {
  if (!object(value) || value.version !== 1 || !validIdentity(value.identity)) return false;
  const actual = value.identity;
  if (!(Object.keys(identity) as Array<keyof OffloadIdentity>).every((key) => actual[key] === identity[key])) return false;
  if (!["marker", "started", "result", "not_started"].includes(String(value.kind))) return false;
  return value.kind !== "result" || (object(value.result) && Number.isInteger(value.result.exitCode)
    && Number.isFinite(value.result.seconds) && (value.result.seconds as number) >= 0);
}

function parseRecord(value: unknown, key: string): OffloadRecord {
  if (!object(value) || value.version !== 1 || typeof value.companyId !== "string" || typeof value.runId !== "string"
    || typeof value.commandId !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || !STATES.has(value.state as OffloadState) || !Number.isFinite(value.acceptedAt) || !Number.isFinite(value.updatedAt)
    || (value.resultAt !== null && !Number.isFinite(value.resultAt))
    || ![null, false, true].includes(value.remoteStarted as null | boolean) || typeof value.fallbackSafe !== "boolean"
    || (value.identity !== null && !validIdentity(value.identity))) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  const record = value as unknown as OffloadRecord;
  if (commandKey(record) !== key || (record.command && (commandKey(record.command) !== key || commandDigest(record.command) !== record.digest))
    || (!record.command && !record.tombstone) || (record.tombstone && !TERMINAL.has(record.state))) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  if (record.identity && (record.identity.companyId !== record.companyId || record.identity.runId !== record.runId
    || record.identity.commandId !== record.commandId || record.identity.digest !== record.digest)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  return record;
}

interface JournalPool {
  hold(identity: OffloadIdentity): Promise<void>;
  release(identity: OffloadIdentity): Promise<void>;
  cancel(command: OffloadCommand, result: OffloadResult): Promise<void>;
}

// One authoritative worker only. Exclusive create fences duplicate IDs, not
// independent workers racing different IDs for a run's 512-slot capacity.
export class OffloadJournal {
  private chain: Promise<unknown> = Promise.resolve();
  private startup: Promise<void> | null = null;
  private readonly inFlight = new Map<string, { digest: string; task: Promise<OffloadResult> }>();
  private readonly active = new Map<string, OffloadRecord>();
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

  private async beforeStart(record: OffloadRecord, patch: Partial<OffloadRecord>): Promise<void> {
    await this.transition(record, async () => {
      if (!PRE_START.has(record.state)) throw offloadError("OFFLOAD_COMMAND_NOT_STARTED");
      await this.commit(record, patch);
    });
  }

  constructor(private readonly deps: OffloadDurableDeps, private readonly now: () => number, private readonly pool: JournalPool) {}

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

  async recover(): Promise<void> {
    if (!this.startup) {
      this.startup = this.serialize(async () => {
        for (const key of await this.deps.journalStore.list("command/")) {
          const record = parseRecord(await this.deps.journalStore.get(key), key);
          if (!TERMINAL.has(record.state) && record.identity) await this.hold(record);
          if (!TERMINAL.has(record.state) && !PRE_START.has(record.state) && !record.identity) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        }
      });
    }
    await this.startup;
  }

  async execute(command: OffloadCommand, launch: () => Promise<OffloadResult>): Promise<OffloadResult> {
    // This must precede startup scanning, journal reads and even cached replies.
    await this.checkRun(command.companyId, command.runId);
    const key = commandKey(command);
    const digest = commandDigest(command);
    const pending = this.inFlight.get(key);
    if (pending) {
      if (pending.digest !== digest) throw offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT");
      return await pending.task;
    }
    const task = this.executeOnce(command, digest, launch);
    this.inFlight.set(key, { digest, task });
    try { return await task; } finally { this.inFlight.delete(key); }
  }

  private async executeOnce(command: OffloadCommand, digest: string, launch: () => Promise<OffloadResult>): Promise<OffloadResult> {
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
    if (!fresh) return await this.replay(record);
    this.active.set(key, record);
    try {
      await this.transition(record, async () => {
        if (PRE_START.has(record.state)) await this.commit(record, { state: "queued" });
      });
      if (record.state === "not_started") return record.result!;
      const result = await launch();
      return result.status === "unavailable" ? await this.finish(command, result) : result;
    } finally {
      this.active.delete(key);
    }
  }

  private async commit(record: OffloadRecord, patch: Partial<OffloadRecord>): Promise<void> {
    const next = { ...record, ...patch, updatedAt: this.now() };
    await this.deps.journalStore.set(commandKey(record), next);
    Object.assign(record, next); // Never advance memory past the durable boundary.
  }

  async run(sandboxId: string, command: OffloadCommand,
    transport: (sandboxId: string, command: OffloadCommand, identity?: OffloadIdentity) => Promise<{ exitCode: number; seconds: number }>) {
    const record = this.active.get(commandKey(command))!;
    await this.beforeStart(record, { state: "syncing_in" });
    // Start the sync in the same continuation as the state check. A subsequent
    // cancellation can fence spawn, but need not abort an already-running push.
    if (record.state === "not_started") throw offloadError("OFFLOAD_COMMAND_NOT_STARTED");
    await this.deps.sync.push(sandboxId, command);
    const bootId = this.deps.guestReceipts.bootId ? await this.deps.guestReceipts.bootId(sandboxId) : `unverified:${randomUUID()}`;
    if (!bootId) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
    const identity: OffloadIdentity = { companyId: command.companyId, runId: command.runId, commandId: command.commandId,
      digest: record.digest, sandboxId, guestBootId: bootId, journalGeneration: 1 };
    await this.beforeStart(record, { state: "starting", identity, remoteStarted: null });
    const result = await transport(sandboxId, command, identity);
    // The legacy transport resolves at exit, not at spawn. Do not claim a
    // running acknowledgement until it actually returns evidence of execution.
    await this.commit(record, { state: "running", remoteStarted: true });
    await this.commit(record, { state: "syncing_out" });
    await this.deps.sync.collect(sandboxId, command);
    await this.deps.sync.stage(sandboxId, command);
    return result;
  }

  async finish(command: OffloadCommand, result: OffloadResult): Promise<OffloadResult> {
    const record = this.active.get(commandKey(command))!;
    const committed = await this.transition(record, async () => {
      if (TERMINAL.has(record.state)) return record.result!;
      // No transport is invoked before the starting commit. A sync/boot-ID
      // failure is therefore a known non-start, not identity-less uncertainty.
      if (PRE_START.has(record.state) && result.status === "unknown") {
        result = this.unavailable(command, "command failed before durable starting intent");
      }
      if (result.status === "unavailable") {
        if (!PRE_START.has(record.state)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
      } else if (result.status === "unknown") {
        await this.commit(record, { state: "unknown", result, resultAt: null, remoteStarted: null, fallbackSafe: false });
      } else {
        await this.commit(record, { state: "completed", result, resultAt: this.now(), remoteStarted: true, fallbackSafe: false });
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

  private async hold(record: OffloadRecord): Promise<void> {
    if (record.identity) {
      this.held.set(commandKey(record), record.identity);
      await this.pool.hold(record.identity);
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
    if (PRE_START.has(record.state)) {
      const result = this.unavailable(record, "recovered before durable starting intent");
      await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
      return result;
    }
    await this.hold(record);
    let answer: unknown = null;
    try { if (record.identity) answer = await this.deps.guestReceipts.read(record.identity); } catch { /* Hold on transport loss. */ }
    if (record.identity && matchingReceipt(answer, record.identity)) {
      if (answer.kind === "result") {
        const raw = answer.result!;
        // Resume only output collection/staging, never command execution.
        await this.commit(record, { state: "syncing_out", remoteStarted: true });
        await this.deps.sync.collect(record.identity.sandboxId, record.command!);
        await this.deps.sync.stage(record.identity.sandboxId, record.command!);
        const result: OffloadResult = { status: "completed", commandId: record.commandId, sandboxId: record.identity.sandboxId,
          warm: "cold" as OffloadWarm, queueWaitMs: 0, ...raw, dollars: 0 };
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

  async readCommand(companyId: string, runId: string, commandId: string): Promise<OffloadCommandView> {
    await this.checkRun(companyId, runId);
    const key = commandKey({ companyId, runId, commandId });
    const record = parseRecord(await this.deps.journalStore.get(key), key);
    if (record.tombstone || (TERMINAL.has(record.state) && record.resultAt !== null && this.now() - record.resultAt >= DAY)) throw offloadError("OFFLOAD_RESULT_EXPIRED");
    return this.view(record);
  }

  private view(record: OffloadRecord): OffloadCommandView {
    const result = record.state === "completed" && record.result && "exitCode" in record.result ? {
      exitCode: record.result.exitCode, signal: null, timedOut: false, cancelled: false,
      syncBack: { state: "clean" as const, changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null,
    } : null;
    return { version: 1, commandId: record.commandId, state: record.state,
      remoteStarted: record.remoteStarted, fallbackSafe: record.fallbackSafe, result };
  }

  async cancelCommand(companyId: string, runId: string, commandId: string, _reason: string): Promise<OffloadCommandView> {
    await this.checkRun(companyId, runId);
    await this.recover();
    const key = commandKey({ companyId, runId, commandId });
    const record = this.active.get(key) ?? parseRecord(await this.deps.journalStore.get(key), key);
    const view = await this.transition(record, async () => {
      // Starting and cancellation use the same record fence. Once intent wins,
      // running cancellation/descendant cleanup belongs to the lifecycle adapter.
      if (PRE_START.has(record.state)) {
        const result = this.unavailable(record, "cancelled before durable starting intent");
        await this.commit(record, { state: "not_started", result, resultAt: this.now(), remoteStarted: false, fallbackSafe: true });
      }
      return this.view(record);
    });
    // Queue capacity/VM ownership is released only after the refusal commit,
    // outside the record fence so pool and journal locks cannot invert.
    if (view.state === "not_started" && record.command && record.result) await this.pool.cancel(record.command, record.result);
    return view;
  }

  async collectGarbage(): Promise<void> {
    await this.serialize(async () => {
      for (const key of await this.deps.journalStore.list("command/")) {
        if (this.inFlight.has(key)) continue;
        const record = parseRecord(await this.deps.journalStore.get(key), key);
        if (!TERMINAL.has(record.state)) continue;
        const run = await this.deps.resolveRunState(record.companyId, record.runId);
        if (record.tombstone && run.permanentlyTerminal && run.terminatedAt !== null
          && this.now() >= run.terminatedAt + 30 * DAY && this.now() >= run.tokenExpiresAt) {
          await this.deps.journalStore.delete(key);
        } else if (!record.tombstone && record.resultAt !== null && this.now() - record.resultAt >= DAY) {
          const { command: _command, ...compact } = record;
          await this.deps.journalStore.set(key, { ...compact, result: null, tombstone: true });
        }
      }
    });
  }
}
