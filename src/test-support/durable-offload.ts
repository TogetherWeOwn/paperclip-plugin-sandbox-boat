import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { OffloadCommand, OffloadDeps } from "../offload.js";
import type { BoatApiLike } from "../boat-client.js";
import type { StateClientLike } from "../state.js";
import { OffloadExecutor } from "../offload.js";
import { FakeBoat } from "./fake-boat.js";

// In-memory account-admission state: the merged executor always requires
// durable ledger deps (state, accountId, poolId) alongside durable journal deps.
export class MemAccountState implements StateClientLike {
  private readonly rows = new Map<string, unknown>();
  private key(input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) {
    return JSON.stringify([input.scopeKind, input.scopeId ?? null, input.namespace ?? null, input.stateKey]);
  }
  async get(input: { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string }): Promise<unknown> {
    return structuredClone(this.rows.get(this.key(input)) ?? null);
  }
  async set(input: { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string }, value: unknown): Promise<void> {
    this.rows.set(this.key(input), structuredClone(value));
  }
  async delete(input: Parameters<StateClientLike["delete"]>[0]): Promise<void> {
    this.rows.delete(this.key(input));
  }
}
let nextTestAccount = 0;
export function testAccount(poolId = "durable-test-pool") {
  return { state: new MemAccountState(), accountId: `durable-test-account-${++nextTestAccount}`, poolId };
}

// Test-owned storage/transport fixtures. No lifecycle, recovery, deduplication,
// retention or quarantine policy is implemented here: all belongs to the SUT.
export const EPOCH = Date.parse("2026-10-23T10:00:00Z");
export const DAY = 86_400_000;
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
export const cargoResult = { exitCode: 23, seconds: 2 };
export const wireResult = {
  exitCode: 23, signal: null, timedOut: false, cancelled: false,
  syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null },
  usageRecordId: null,
};
export type Command = OffloadCommand & {
  executionWorkspaceId: string; cwdRelative: string; env: Record<string, string>; timeoutMs: number;
};
export function command(commandId = "command-1", partial: Partial<Command> = {}): Command {
  return {
    companyId: "company-1", runId: "run-1", cardId: "card-1", repoId: "repo-1",
    profileId: "rust-secret-free", commandId, executionWorkspaceId: "workspace-1",
    cwdRelative: ".", argv: ["test", "--locked"], env: { CARGO_TERM_COLOR: "never" },
    timeoutMs: 1_200_000, queueTimeoutMs: 30_000, ...partial,
  };
}

// Normative test-facing digest encoding: recursively sort object keys, preserve
// array order; include the complete validated execution payload/host bindings.
export function digest(cmd: Command): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, value]) => [k, canonical(value)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(cmd))).digest("hex");
}
export interface Identity {
  companyId: string; runId: string; commandId: string; digest: string;
  sandboxId: string; guestBootId: string; journalGeneration: number;
}
export function identity(cmd = command()): Identity {
  return {
    companyId: cmd.companyId, runId: cmd.runId, commandId: cmd.commandId, digest: digest(cmd),
    sandboxId: "bx_durable", guestBootId: "boot-1", journalGeneration: 1,
  };
}
export type State = "accepted" | "queued" | "syncing_in" | "starting" | "running"
  | "syncing_out" | "completed" | "not_started" | "cancelled" | "failed" | "unknown";
export interface RecordV1 {
  version: 1; commandId: string; runId: string; companyId: string;
  command: Command; digest: string; state: State; identity: Identity | null;
  acceptedAt: number; updatedAt: number; resultAt: number | null;
  result: unknown; remoteStarted: boolean | null; fallbackSafe: boolean;
  tombstone?: boolean;
}
export function record(state: State, cmd = command()): RecordV1 {
  const preStart = ["accepted", "queued", "syncing_in", "not_started"].includes(state);
  return {
    version: 1, commandId: cmd.commandId, runId: cmd.runId, companyId: cmd.companyId,
    command: cmd, digest: digest(cmd), state, identity: preStart ? null : identity(cmd),
    acceptedAt: EPOCH, updatedAt: EPOCH,
    resultAt: ["completed", "not_started", "cancelled", "failed"].includes(state) ? EPOCH : null,
    result: state === "completed" ? {
      status: "completed", commandId: cmd.commandId, ...cargoResult,
      sandboxId: "bx_durable", remoteStarted: true, fallbackSafe: false,
    } : null,
    remoteStarted: preStart ? false : state === "starting" || state === "unknown" ? null : true,
    fallbackSafe: state === "not_started",
  };
}
export const hostKey = (cmd: Command) => `command/${cmd.companyId}/${cmd.runId}/${cmd.commandId}`;
export const guestKey = (id: Identity, kind: string) => `guest/${id.companyId}/${id.runId}/${id.commandId}/${kind}`;
export type Receipt = {
  version: 1; kind: "marker" | "started" | "result" | "not_started";
  identity: Identity; result?: typeof cargoResult; processGroupId?: number;
  cgroupPath?: string; guestDeadline?: number; heartbeatDeadline?: number;
};
export const receipt = (kind: Receipt["kind"], id = identity()): Receipt => ({
  version: 1, kind, identity: id,
  ...(kind === "result" ? { result: { ...cargoResult } } : {}),
  ...(kind === "started" ? {
    processGroupId: 2345, cgroupPath: "/delegated/command-1",
    guestDeadline: EPOCH + 1_200_000, heartbeatDeadline: EPOCH + 30_000,
  } : {}),
});

// Each operation opens actual files. Reopening FileStore never shares a Map or
// cached record. Atomic create is the guest's exclusive marker primitive.
export class FileStore {
  readonly writes: Array<{ key: string; value: unknown }> = [];
  readonly reads: string[] = [];
  fail: ((key: string, value: unknown, operation: "set" | "create" | "delete") => boolean) | null = null;
  constructor(readonly directory: string) {}
  private file(key: string) { return join(this.directory, `${Buffer.from(key).toString("hex")}.json`); }
  async get(key: string): Promise<unknown> {
    this.reads.push(key);
    try { return JSON.parse(await readFile(this.file(key), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async list(prefix: string): Promise<string[]> {
    this.reads.push(`list:${prefix}`);
    await mkdir(this.directory, { recursive: true });
    return (await readdir(this.directory)).filter((file) => file.endsWith(".json"))
      .map((file) => Buffer.from(file.slice(0, -5), "hex").toString()).filter((key) => key.startsWith(prefix)).sort();
  }
  async set(key: string, value: unknown): Promise<void> {
    if (this.fail?.(key, value, "set")) throw new Error("INJECTED_DURABILITY_FAILURE");
    await mkdir(this.directory, { recursive: true });
    const destination = this.file(key);
    const temporary = `${destination}.${crypto.randomUUID()}.pending`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
    await this.syncDirectory();
    this.writes.push({ key, value: structuredClone(value) });
  }
  async create(key: string, value: unknown): Promise<boolean> {
    if (this.fail?.(key, value, "create")) throw new Error("INJECTED_DURABILITY_FAILURE");
    await mkdir(this.directory, { recursive: true });
    let handle;
    try { handle = await open(this.file(key), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory();
    this.writes.push({ key, value: structuredClone(value) });
    return true;
  }
  async delete(key: string): Promise<void> {
    if (this.fail?.(key, null, "delete")) throw new Error("INJECTED_DURABILITY_FAILURE");
    try { await unlink(this.file(key)); await this.syncDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async syncDirectory() {
    const dir = await open(this.directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
}
export interface RunState { permanentlyTerminal: boolean; terminatedAt: number | null; tokenExpiresAt: number; }
export type DurableDeps = OffloadDeps & {
  journalStore: FileStore;
  guestReceipts: { read(id: Identity): Promise<unknown> };
  resolveRunState(companyId: string, runId: string): Promise<RunState>;
  sync: { push(vm: string, cmd: Command): Promise<void>; collect(vm: string, cmd: Command): Promise<void>; stage(vm: string, cmd: Command): Promise<void> };
};
export interface View {
  version: 1; commandId: string; state: State; remoteStarted: boolean | null;
  fallbackSafe: boolean; result: typeof wireResult | null;
}
export type Executor = OffloadExecutor & {
  recover(): Promise<void>;
  collectGarbage(): Promise<void>;
  readCommand(companyId: string, runId: string, commandId: string): Promise<View>;
  cancelCommand(companyId: string, runId: string, commandId: string, reason: string): Promise<View>;
};
export async function settled<T>(p: Promise<T>): Promise<T | { rejected: string; code?: string }> {
  try { return await p; } catch (error) {
    return { rejected: String(error), code: (error as { code?: string }).code };
  }
}
export function harness(root: string) {
  const clock = { t: EPOCH };
  const boat = new FakeBoat({ now: () => clock.t });
  const timers = new Map<number, { at: number; cb: () => void }>();
  let serial = 0;
  const attempts: Array<{ vm: string; command: Command; intent: unknown; identity: Identity | undefined }> = [];
  const runStates = new Map<string, RunState>();
  let guestAnswer: unknown = null;
  const receiptReads: Identity[] = [];
  const hostDirectory = join(root, "host");
  const guestDirectory = join(root, "guest");
  const account = testAccount();
  const openExecutor = (override: Partial<DurableDeps> = {}) => {
    const store = new FileStore(hostDirectory);
    const deps: DurableDeps = {
      ...account,
      boat: boat as unknown as BoatApiLike, logger: { info() {}, warn() {}, error() {} }, now: () => clock.t,
      timers: {
        set(cb, ms) { const id = ++serial; timers.set(id, { at: clock.t + ms, cb }); return id; },
        clear(id) { timers.delete(id as number); },
      },
      config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0, queueTimeoutMs: 0 },
      journalStore: store,
      resolveRunState: async (_companyId, runId) => runStates.get(runId)
        ?? { permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + 40 * DAY },
      guestReceipts: { read: async (id) => { receiptReads.push(id); return structuredClone(guestAnswer); } },
      sync: { push: async () => {}, collect: async () => {}, stage: async () => {} },
      runCommand: async (vm, cmd, ...rest: unknown[]) => {
        attempts.push({ vm, command: cmd as Command, intent: await new FileStore(hostDirectory).get(hostKey(cmd as Command)), identity: rest[0] as Identity | undefined });
        return { ...cargoResult };
      }, ...override,
    };
    return { executor: new OffloadExecutor(deps) as Executor, store: deps.journalStore };
  };
  const advance = async (ms: number) => {
    const target = clock.t + ms;
    for (let n = 0; n < 1000; n++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock.t = target; await flush(); return; }
      timers.delete(next[0]); clock.t = next[1].at; next[1].cb(); await flush();
    }
    throw new Error("timer did not quiesce");
  };
  return {
    clock, boat, timers, attempts, runStates, hostDirectory, guestDirectory, receiptReads,
    openExecutor, advance, setReceipt(value: unknown) { guestAnswer = value; },
    crash() { timers.clear(); }, // process-style crash: no graceful shutdown side effects
  };
}
