// Acceptance-only ports for ADR 0001. No journal, ledger, scheduler or cleanup
// implementation lives here. Replace provisional type bindings with the durable
// journal/account interfaces when those prerequisites land; keep assertions.
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffloadExecutor } from "../offload.js";
import type { OffloadCommand, OffloadDeps, OffloadResult } from "../offload.js";
import type { StateClientLike } from "../state.js";
import type { OffloadStore } from "../offload-journal.js";
import type { BoatApiLike } from "../boat-client.js";
import { FakeBoat } from "./fake-boat.js";

export const EPOCH = Date.parse("2026-10-23T10:00:00Z");
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
export const completed = () => ({ exitCode: 0, seconds: 1 });
export async function until(predicate: () => boolean) {
  for (let n = 0; n < 1000; n += 1) { if (predicate()) return; await flush(); }
  throw new Error("expected externally observable phase was never reached");
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export interface LifecycleCommand extends OffloadCommand {
  executionWorkspaceId: string;
  trustDomainId: string;
}
export function command(commandId: string, patch: Partial<LifecycleCommand> = {}): LifecycleCommand {
  return {
    commandId, companyId: "company-a", runId: "run-a", cardId: "card-a",
    executionWorkspaceId: "workspace-a", repoId: "repo-a", profileId: "rust-public",
    trustDomainId: "trusted-public", argv: ["test", "--locked"], timeoutMs: 120_000,
    ...patch,
  };
}

export interface GuestIdentity {
  guestBootId: string;
  processGroupId: number;
  cgroupPath: string;
  journalGeneration: number;
  heartbeatDeadline: number;
  guestDeadline: number;
}
export interface OutputEvent { seq: number; stream: "stdout" | "stderr"; dataBase64: string }
export interface ReadReceipt {
  version: 1;
  commandId: string;
  state: string;
  remoteStarted: boolean | null;
  fallbackSafe: boolean;
  events: OutputEvent[];
  nextCursor: number;
  result: unknown;
}
export interface LifecycleApi {
  start(cmd: LifecycleCommand): Promise<ReadReceipt>;
  read(commandId: string, after: number, limitBytes?: number): Promise<ReadReceipt>;
  heartbeat(commandId: string, journalGeneration?: number): Promise<unknown>;
  cancel(commandId: string, reason: string, journalGeneration?: number): Promise<unknown>;
  recover(): Promise<unknown>;
  sweep(): Promise<unknown>;
}
export interface RunContext {
  identity: GuestIdentity;
  output(stream: "stdout" | "stderr", bytes: Uint8Array): void | Promise<void>;
}

// Manual time, with separate guest/worker timer ownership. Killing a worker
// clears only worker timers; an armed external watchdog remains runnable.
export class Clock {
  t = EPOCH;
  serial = 0;
  timers = new Map<number, { at: number; cb: () => void; owner: "worker" | "guest" }>();
  now = () => this.t;
  set = (cb: () => void, ms: number, owner: "worker" | "guest" = "worker") => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.t + ms, cb, owner });
    return id;
  };
  clear = (handle: unknown) => { this.timers.delete(handle as number); };
  crashWorker() {
    for (const [id, timer] of this.timers) if (timer.owner === "worker") this.timers.delete(id);
  }
  async advance(ms: number) {
    // Flush initiating async operations before moving time, like tickAsync:
    // otherwise cancel()->persist->TERM schedules its five-second grace only
    // after the clock has already jumped five seconds into the future.
    await flush();
    const until = this.t + ms;
    for (let n = 0; ; n += 1) {
      if (n > 10_000) throw new Error("unbounded timer loop");
      const next = [...this.timers].filter(([, v]) => v.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].cb();
      await flush();
    }
    this.t = until;
    await flush();
  }
}

// Generic file-backed host state transport, NOT an alternative command journal.
// Reopening reads bytes from disk, never a Map from an old executor instance.
export class DiskState implements StateClientLike {
  writes: unknown[] = [];
  reads = 0;
  failWrites = false;
  constructor(readonly path: string) {}
  async all(): Promise<Record<string, unknown>> {
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  // Acceptance transport adapter for the now-required journal interface. All
  // policy remains in OffloadJournal; the same disk document is reopened below.
  store(): OffloadStore {
    const key = (stateKey: string) => ({ scopeKind: "instance" as const, namespace: "guest-test-journal", stateKey });
    return {
      get: (id) => this.get(key(id)),
      set: (id, value) => this.set(key(id), value),
      create: async (id, value) => {
        if (await this.get(key(id)) !== null) return false;
        await this.set(key(id), value);
        return true;
      },
      delete: async (id) => {
        const doc = await this.all();
        delete doc[JSON.stringify(key(id))];
        writeFileSync(this.path, JSON.stringify(doc));
      },
      list: async (prefix) => Object.keys(await this.all()).map((id) => JSON.parse(id) as ReturnType<typeof key>)
        .filter((id) => id.namespace === "guest-test-journal" && id.stateKey.startsWith(prefix)).map((id) => id.stateKey),
    };
  }
  async get(key: Parameters<StateClientLike["get"]>[0]) {
    this.reads += 1;
    return (await this.all())[JSON.stringify(key)] ?? null;
  }
  async set(key: Parameters<StateClientLike["set"]>[0], value: unknown) {
    if (this.failWrites) throw new Error("test host persistence unavailable");
    const doc = await this.all();
    doc[JSON.stringify(key)] = structuredClone(value);
    writeFileSync(this.path, JSON.stringify(doc));
    this.writes.push(structuredClone(value));
  }
  async delete(key: Parameters<StateClientLike["delete"]>[0]) {
    if (this.failWrites) throw new Error("test host persistence unavailable");
    const doc = await this.all();
    delete doc[JSON.stringify(key)];
    writeFileSync(this.path, JSON.stringify(doc));
  }
}

interface ProcessTree {
  identity: GuestIdentity;
  leaderAlive: boolean;
  escapedDescendantAlive: boolean;
  receipt: "running" | "completed" | "unknown" | "never_started";
}
export class Guest {
  delegated: boolean | null = true;
  watchdog: boolean | null = true;
  observable = true;
  failKill = false;
  failVerify = false;
  trees = new Map<string, ProcessTree>();
  prepared = new Map<string, GuestIdentity>();
  actions: Array<{ kind: string; at: number; commandId?: string; identity?: GuestIdentity }> = [];
  onEmpty: (identity: GuestIdentity) => void = () => {};
  constructor(readonly clock: Clock) {}
  preflight = async () => ({ cgroupV2Delegated: this.delegated, outsideWatchdogVerified: this.watchdog });
  prepare = async (_sandboxId: string, cmd: LifecycleCommand): Promise<GuestIdentity> => {
    const identity = {
      guestBootId: "boot-a", processGroupId: 4100 + this.prepared.size,
      cgroupPath: `/delegated/commands/${cmd.commandId}`, journalGeneration: 1,
      heartbeatDeadline: this.clock.t + 30_000, guestDeadline: this.clock.t + (cmd.timeoutMs ?? 120_000),
    };
    this.prepared.set(cmd.commandId, identity);
    return structuredClone(identity);
  };
  armDeadline = async (_sandboxId: string, identity: GuestIdentity) => {
    this.actions.push({ kind: "arm", at: this.clock.t, identity });
    this.clock.set(() => {
      this.actions.push({ kind: "watchdog", at: this.clock.t, identity });
      for (const tree of this.trees.values()) if (tree.identity.cgroupPath === identity.cgroupPath) {
        tree.leaderAlive = false;
        tree.escapedDescendantAlive = false;
      }
      this.onEmpty(identity);
    }, Math.max(0, identity.guestDeadline - this.clock.t), "guest");
    return { verified: true, outsideCommandCgroup: true };
  };
  inspect = async (_sandboxId: string, identity: GuestIdentity) => {
    this.actions.push({ kind: "inspect", at: this.clock.t, identity });
    if (!this.observable) throw new Error("guest ownership unobservable");
    const tree = [...this.trees.values()].find((v) => v.identity.cgroupPath === identity.cgroupPath);
    return tree ? { identity: structuredClone(tree.identity), receipt: tree.receipt, populated: this.aliveTree(tree) }
      : { identity, receipt: "never_started", populated: false };
  };
  term = async (_sandboxId: string, identity: GuestIdentity) => {
    this.actions.push({ kind: "term", at: this.clock.t, identity });
    // An adversarial child left the original process group; TERM cannot reach it.
    for (const tree of this.trees.values()) if (tree.identity.processGroupId === identity.processGroupId) tree.leaderAlive = false;
  };
  kill = async (_sandboxId: string, identity: GuestIdentity) => {
    this.actions.push({ kind: "kill", at: this.clock.t, identity });
    if (this.failKill) throw new Error("cgroup kill failed");
    for (const tree of this.trees.values()) if (tree.identity.cgroupPath === identity.cgroupPath) {
      tree.leaderAlive = false;
      tree.escapedDescendantAlive = false;
    }
    this.onEmpty(identity);
  };
  verifyEmpty = async (_sandboxId: string, identity: GuestIdentity) => {
    this.actions.push({ kind: "verify", at: this.clock.t, identity });
    if (this.failVerify) throw new Error("subtree population unreadable");
    return ![...this.trees.values()].some((v) => v.identity.cgroupPath === identity.cgroupPath && this.aliveTree(v));
  };
  spawn(cmd: LifecycleCommand, context?: RunContext) {
    // Legacy runCommand remains executable, but does NOT pretend that the real
    // executor prepared/persisted identity or armed a watchdog.
    const identity = context?.identity ?? {
      guestBootId: "boot-a", processGroupId: 4100, cgroupPath: `/delegated/commands/${cmd.commandId}`,
      journalGeneration: 1, heartbeatDeadline: this.clock.t + 30_000,
      guestDeadline: this.clock.t + (cmd.timeoutMs ?? 120_000),
    };
    this.trees.set(cmd.commandId, { identity: structuredClone(identity), leaderAlive: true, escapedDescendantAlive: true, receipt: "running" });
    this.actions.push({ kind: "spawn", commandId: cmd.commandId, at: this.clock.t, identity });
  }
  exit(commandId: string, descendants = false) {
    const tree = this.trees.get(commandId)!;
    tree.leaderAlive = false;
    tree.escapedDescendantAlive = descendants && tree.escapedDescendantAlive;
    tree.receipt = "completed";
  }
  private aliveTree(tree: ProcessTree) { return tree.leaderAlive || tree.escapedDescendantAlive; }
  alive(id: string) { const tree = this.trees.get(id); return tree ? this.aliveTree(tree) : false; }
}

export async function fixture() {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR
    ?? process.env.RUNNER_TEMP ?? tmpdir();
  const root = await mkdtemp(join(scratch, "guest-contract-"));
  const liveRoot = join(root, "live");
  const stageRoot = join(root, "staged");
  await mkdir(liveRoot);
  await mkdir(stageRoot);
  await writeFile(join(liveRoot, "Cargo.lock"), "local baseline\n");
  const clock = new Clock();
  const boat = new FakeBoat({ now: clock.now });
  const guest = new Guest(clock);
  const state = new DiskState(join(root, "state.json"));
  const trace: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const fail = new Set<string>();
  guest.onEmpty = (identity) => {
    for (const [id, tree] of guest.trees) if (tree.identity.cgroupPath === identity.cgroupPath) gates.get(`exec:${id}`)?.resolve();
  };
  const starts: Array<{ sandboxId: string; commandId: string; context?: RunContext; persisted: unknown }> = [];
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const pending: Promise<OffloadResult>[] = [];
  const phase = async (name: string, id: string) => {
    trace.push(`${name}:${id}`);
    await gates.get(`${name}:${id}`)?.promise;
    if (fail.has(`${name}:${id}`)) throw new Error(`injected ${name} failure`);
  };
  const sync = {
    push: async (_vm: string, cmd: LifecycleCommand) => { await phase("push", cmd.commandId); },
    collect: async (_vm: string, cmd: LifecycleCommand) => {
      await phase("collect", cmd.commandId);
      return { changedPaths: ["Cargo.lock"], files: [{ path: "Cargo.lock", dataBase64: Buffer.from("remote proposal\n").toString("base64") }] };
    },
    stage: async (cmd: LifecycleCommand, _collected: unknown) => {
      await phase("stage", cmd.commandId);
      return { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: `artifact-${cmd.commandId}` };
    },
  };
  let keepDescendants = false;
  let output: Array<["stdout" | "stderr", Uint8Array]> = [];
  const executors: OffloadExecutor[] = [];
  const make = (config: Partial<OffloadDeps["config"]> = {}, disk = state) => {
    const deps = {
      boat: boat as unknown as BoatApiLike, logger: {
        info: (message: string, meta?: Record<string, unknown>) => { logs.push({ message, meta }); },
        warn: (message: string, meta?: Record<string, unknown>) => { logs.push({ message, meta }); },
        error: (message: string, meta?: Record<string, unknown>) => { logs.push({ message, meta }); },
      }, now: clock.now, timers: { set: clock.set, clear: clock.clear },
      config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, ...config },
      state: disk, accountId: `guest-test:${root}`, poolId: "guest-test-pool", guest,
      journalStore: disk.store(),
      guestReceipts: { bootId: async () => "boot-a", read: async () => null },
      resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + 86_400_000 }),
      // slice c will exercise collected-data/staging results; preserve the
      // landed journal's void sync contract until that adapter slice lands.
      sync: {
        push: sync.push,
        collect: async (vm: string, cmd: OffloadCommand) => { await sync.collect(vm, cmd as LifecycleCommand); },
        stage: async (_vm: string, cmd: OffloadCommand) => { await sync.stage(cmd as LifecycleCommand, undefined); },
      },
      runCommand: async (sandboxId: string, raw: OffloadCommand, context?: RunContext) => {
        const cmd = raw as LifecycleCommand;
        const start = { sandboxId, commandId: cmd.commandId, context, persisted: undefined as unknown };
        starts.push(start);
        start.persisted = await disk.all();
        guest.spawn(cmd, context);
        for (const [stream, bytes] of output) await context?.output(stream, bytes);
        await phase("exec", cmd.commandId);
        guest.exit(cmd.commandId, keepDescendants);
        return completed();
      },
    };
    const executor = new OffloadExecutor(deps);
    executors.push(executor);
    return executor;
  };
  const executor = make();
  // Optional dispatch is ONLY a baseline compatibility shim: absent methods do
  // nothing, so assertions can witness real surviving processes/missing output
  // instead of TypeError/import failures. It NEVER synthesizes safe receipts.
  const api = (ex: OffloadExecutor = executor) => ex as unknown as Partial<LifecycleApi>;
  const execute = (cmd: LifecycleCommand, ex = executor) => {
    const p = ex.execute(cmd);
    pending.push(p);
    return p;
  };
  const hold = (name: string) => { const gate = deferred<void>(); gates.set(name, gate); return gate; };
  const dispose = async () => {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled(pending);
    // start() intentionally detaches execution from its acknowledgement. Drain
    // those journal-owned tasks too before deleting their persistence files.
    await Promise.allSettled(executors.map((executor) => executor.shutdown()));
    clock.timers.clear();
    await rm(root, { recursive: true, force: true });
  };
  return {
    root, liveRoot, stageRoot, clock, boat, guest, state, trace, starts, logs,
    executor, api, execute, make, hold, fail, dispose,
    descendants: (value = true) => { keepDescendants = value; },
    output: (value: typeof output) => { output = value; },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
