import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffloadExecutor, type OffloadDeps } from "./offload.js";
import {
  FileStore, cargoResult, command, flush, harness, hostKey, settled,
  type Command, type Executor, type RecordV1,
} from "./test-support/durable-offload.js";

// Acceptance-owned additions. ADR lifecycle/queue fences (lines 49–61),
// idempotent cancellation (111), and complete-payload identity (53).
// No original acceptance file or production implementation is modified.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function observe<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T | { rejected: string; code?: string } } = { done: false };
  const completion = settled(promise).then((value) => { state.done = true; state.value = value; return value; });
  return { state, completion };
}

// Only the storage boundary is delayed/failed. Reads and successful writes still
// use the original fsync/atomic-replace FileStore, including independent reopen.
class RefusalStore extends FileStore {
  readonly entered = gate();
  readonly commit = gate();
  constructor(directory: string, readonly target: Command, readonly failCommit: boolean) { super(directory); }
  override async set(key: string, value: unknown) {
    if (key === hostKey(this.target) && (value as RecordV1).state === "not_started") {
      this.entered.release();
      await this.commit.promise;
      if (this.failCommit) throw new Error("INJECTED_REFUSAL_COMMIT_FAILURE");
    }
    await super.set(key, value);
  }
}

let root: string;
let h: ReturnType<typeof harness>;
let releases: Array<() => void>;
let pending: Promise<unknown>[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "offload-live-regressions-"));
  h = harness(root);
  releases = [];
  pending = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  try {
    for (const release of releases) release();
    await h.advance(120_000);
    await Promise.all(pending);
    await flush();
    expect(unhandled, "timer/drain failures must not create unhandled rejections").toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    h.crash();
    await rm(root, { recursive: true, force: true });
  }
});
function hold() { const g = gate(); releases.push(g.release); return g; }
function track<T>(promise: Promise<T>) {
  const observation = observe(promise);
  pending.push(observation.completion);
  return observation;
}
const disk = (cmd: Command) => new FileStore(h.hostDirectory).get(hostKey(cmd));
const cancel = (executor: Executor, cmd: Command) => executor.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
const view = (executor: Executor, cmd: Command) => executor.readCommand(cmd.companyId, cmd.runId, cmd.commandId);
const queuedCommand = (id = "waiter", timeoutMs = 1_000) => command(id, {
  cardId: `card-${id}`, executionWorkspaceId: `workspace-${id}`, queueTimeoutMs: timeoutMs,
});
const queueConfig = { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 1, queueTimeoutMs: 30_000 };
async function liveQueued(cmd: Command) {
  // Disk alone is not enough: queued is also an intermediate state on the way
  // to admission. The fake deadline proves the command is a live pool waiter.
  await vi.waitFor(async () => {
    expect(await disk(cmd)).toMatchObject({ state: "queued" });
    expect([...h.timers.values()].some((timer) => timer.at === h.clock.t + cmd.queueTimeoutMs!)).toBe(true);
  }, { interval: 1 });
}
function busyExecutor(store?: FileStore) {
  const running = hold();
  const started = gate();
  const effects: string[] = [];
  const syncEffects: string[] = [];
  const { executor } = h.openExecutor({
    config: queueConfig,
    ...(store ? { journalStore: store } : {}),
    sync: {
      push: async (_vm, cmd) => { syncEffects.push(`${cmd.commandId}/push`); },
      collect: async (_vm, cmd) => { syncEffects.push(`${cmd.commandId}/collect`); },
      stage: async (_vm, cmd) => { syncEffects.push(`${cmd.commandId}/stage`); },
    },
    runCommand: async (_vm, cmd) => {
      effects.push(cmd.commandId);
      if (cmd.commandId === "occupant") { started.release(); await running.promise; }
      return { ...cargoResult };
    },
  });
  const first = track(executor.execute(command("occupant")));
  return { executor, running, started, effects, syncEffects, first };
}

// Break caught: a known pre-spawn sync failure must not manufacture an
// identity-less unknown record that makes every future startup throw.
describe("durable pre-start sync failures", () => {
  it("persists never-started after sync.push failure and replays it across a fresh executor", async () => {
    const cmd = command("push-failed");
    const first = h.openExecutor({ sync: {
      push: async () => { throw new Error("INJECTED_SYNC_PUSH_FAILURE"); },
      collect: async () => {}, stage: async () => {},
    } });
    const refusal = await settled(first.executor.execute(cmd));
    expect.soft(h.attempts).toHaveLength(0);
    expect.soft(refusal).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    h.crash();
    const restarted = h.openExecutor();
    const replay = await settled(restarted.executor.execute(cmd));
    expect.soft(replay).toEqual(refusal);
    expect.soft(await settled(restarted.executor.execute(command("unrelated")))).toMatchObject({ status: "completed" });
    expect.soft(h.attempts.map((attempt) => attempt.command.commandId)).toEqual(["unrelated"]);
  });

  it("failed pre-start refusal commit stays unsafe until restart durably fences it without poisoning admission", async () => {
    const cmd = command("push-and-commit-failed");
    const store = new RefusalStore(h.hostDirectory, cmd, true);
    store.commit.release();
    const first = h.openExecutor({ journalStore: store, sync: {
      push: async () => { throw new Error("INJECTED_SYNC_PUSH_FAILURE"); },
      collect: async () => {}, stage: async () => {},
    } });
    const result = await settled(first.executor.execute(cmd));
    expect.soft(result).not.toMatchObject({ fallbackSafe: true });
    expect.soft(h.attempts).toHaveLength(0);
    // Do not require skipping corrupt/unknown ownership evidence. This input
    // began as a real, known pre-start operation, not an unverifiable seed.
    expect.soft(await disk(cmd)).not.toMatchObject({ state: "unknown", identity: null });
    h.crash();
    const restarted = h.openExecutor();
    expect.soft(await settled(restarted.executor.recover())).toBeUndefined();
    expect.soft(await settled(restarted.executor.execute(cmd))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
    expect.soft(await settled(restarted.executor.execute(command("unrelated-after-write-loss")))).toMatchObject({ status: "completed" });
    expect.soft(h.attempts.map((attempt) => attempt.command.commandId)).toEqual(["unrelated-after-write-loss"]);
  });
});

// Break caught: inFlight includes waiting/syncing submissions too; it is not
// evidence that Cargo started and must not exclude those IDs from cancellation.
describe("live pre-spawn cancellation", () => {
  it("cancels a durably queued execute, preserves duplicate cancel/replay, and never dispatches it", async () => {
    const b = busyExecutor();
    await b.started.promise;
    const cmd = queuedCommand("cancelled-waiter", 5_000);
    const second = track(b.executor.execute(cmd));
    await liveQueued(cmd);
    expect(second.state.done).toBe(false);
    const cancellation = await cancel(b.executor, cmd);
    expect.soft(cancellation).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
    expect.soft(await cancel(b.executor, cmd)).toEqual(cancellation);
    b.running.release();
    await b.first.completion;
    await h.advance(30_000);
    expect.soft(await second.completion).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(b.effects).toEqual(["occupant"]);
    expect.soft(b.syncEffects.filter((effect) => effect.startsWith(`${cmd.commandId}/`))).toEqual([]);
    h.crash();
    const restarted = h.openExecutor().executor;
    expect.soft(await view(restarted, cmd)).toEqual(cancellation);
    expect.soft(await settled(restarted.execute(cmd))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(h.attempts).toHaveLength(0);
  });

  it("a cancellation during gated sync.push fences the delayed continuation before starting", async () => {
    const cmd = command("cancel-during-push");
    const pushing = gate();
    const releasePush = hold();
    const syncEffects: string[] = [];
    const { executor } = h.openExecutor({ sync: {
      push: async () => { syncEffects.push("push"); pushing.release(); await releasePush.promise; },
      collect: async () => { syncEffects.push("collect"); },
      stage: async () => { syncEffects.push("stage"); },
    } });
    const execution = track(executor.execute(cmd));
    await pushing.promise;
    expect(await disk(cmd)).toMatchObject({ state: "syncing_in" });
    const cancellation = await cancel(executor, cmd);
    expect.soft(cancellation).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
    expect.soft(await cancel(executor, cmd)).toEqual(cancellation);
    releasePush.release();
    expect.soft(await execution.completion).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    await h.advance(30_000);
    expect.soft(h.attempts).toHaveLength(0);
    expect.soft(syncEffects).toEqual(["push"]);
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
    h.crash();
    expect.soft(await settled(h.openExecutor().executor.execute(cmd))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(h.attempts).toHaveLength(0);
  });
});

// Break caught: resolving/removing a volatile waiter before finish() commits
// not_started frees queue capacity too early, even if public execute still waits.
describe("live queue refusal commit ordering", () => {
  it.each([false, true])("timeout retains its queue slot until durable refusal (commit fails=%s)", async (failCommit) => {
    const cmd = queuedCommand();
    const store = new RefusalStore(h.hostDirectory, cmd, failCommit);
    releases.push(store.commit.release);
    const b = busyExecutor(store);
    await b.started.promise;
    const waiter = track(b.executor.execute(cmd));
    await liveQueued(cmd);
    await h.advance(1_000);
    await store.entered.promise;
    expect.soft(await disk(cmd)).toMatchObject({ state: "queued", fallbackSafe: false });
    expect.soft(waiter.state.done, "public execute must still await the journal commit").toBe(false);
    if (failCommit) { store.commit.release(); await waiter.completion; }

    // Black-box queue-capacity probe: queueLimit=1, sole VM still occupied.
    // A retained slot rejects a third ID immediately. A prematurely freed slot
    // instead installs this new ID's 5s timer, proving that it joined the queue.
    const probe = queuedCommand("capacity-probe", 5_000);
    const third = track(b.executor.execute(probe));
    await vi.waitFor(() => {
      expect(third.state.done || [...h.timers.values()].some((timer) => timer.at === h.clock.t + 5_000)).toBe(true);
    }, { interval: 1 });
    expect.soft(third.state.value, "a refusal not yet committed must still occupy the bounded queue").toMatchObject({
      code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true,
    });
    store.commit.release();
    const refusal = await waiter.completion;
    if (failCommit) expect.soft(refusal).not.toMatchObject({ fallbackSafe: true });
    else expect.soft(refusal).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    b.running.release();
    await b.first.completion;
    await h.advance(10_000);
    await third.completion;
    expect.soft(b.effects).not.toContain(cmd.commandId);
    h.crash();
    const restarted = h.openExecutor().executor;
    expect.soft(await settled(restarted.recover())).toBeUndefined();
    expect.soft(await settled(restarted.execute(cmd))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect.soft(h.attempts).toHaveLength(0);
  });

  it.each([false, true])("shutdown keeps public fallback unsafe while refusal is blocked or fails (commit fails=%s)", async (failCommit) => {
    const cmd = queuedCommand("shutdown-waiter", 5_000);
    const store = new RefusalStore(h.hostDirectory, cmd, failCommit);
    releases.push(store.commit.release);
    const b = busyExecutor(store);
    await b.started.promise;
    const waiter = track(b.executor.execute(cmd));
    await liveQueued(cmd);
    const shutdown = track(b.executor.shutdown());
    await store.entered.promise;
    // Finish the healthy occupant so it cannot mask whether shutdown is waiting
    // for the refusal. No public-fallback leak is fabricated: execute waits too.
    b.running.release();
    await b.first.completion;
    await flush();
    expect.soft(shutdown.state.done, "drain cannot finish while its never-started receipt is uncommitted").toBe(false);
    expect.soft(waiter.state.done).toBe(false);
    expect.soft(await disk(cmd)).toMatchObject({ state: "queued", fallbackSafe: false });
    store.commit.release();
    const refusal = await waiter.completion;
    if (failCommit) {
      expect.soft(refusal).not.toMatchObject({ fallbackSafe: true });
      // The ADR does not prescribe shutdown's error channel. Enforce the
      // fallback fence, not a guessed requirement that shutdown must reject.
      await shutdown.completion;
      expect.soft(await disk(cmd)).toMatchObject({ state: "queued", fallbackSafe: false });
      expect.soft(await view(b.executor, cmd)).toMatchObject({ fallbackSafe: false });
    } else {
      expect.soft(refusal).toMatchObject({ remoteStarted: false, fallbackSafe: true });
      expect.soft(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
      await shutdown.completion;
    }
    await h.advance(30_000);
    expect.soft(b.effects).toEqual(["occupant"]);
    expect.soft(b.syncEffects.filter((effect) => effect.startsWith(`${cmd.commandId}/`))).toEqual([]);
    h.crash();
    const restarted = h.openExecutor().executor;
    expect.soft(await settled(restarted.recover())).toBeUndefined();
    expect.soft(await settled(restarted.execute(cmd))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect.soft(h.attempts).toHaveLength(0);
  });
});

// Break caught: the compatibility constructor must not silently coalesce two
// different complete validated payloads just because repo/profile/argv match.
describe("legacy constructor complete-payload idempotency", () => {
  function legacy() {
    const g = hold();
    const started = gate();
    const effects: string[] = [];
    let serial = 0;
    const deps: OffloadDeps = {
      boat: h.boat as unknown as OffloadDeps["boat"], logger: { info() {}, warn() {}, error() {} }, now: () => h.clock.t,
      timers: { set(cb, ms) { const id = ++serial; h.timers.set(id, { at: h.clock.t + ms, cb }); return id; }, clear(id) { h.timers.delete(id as number); } },
      config: queueConfig,
      runCommand: async (_vm, cmd) => { effects.push(cmd.commandId); started.release(); await g.promise; return { ...cargoResult }; },
    };
    return { executor: new OffloadExecutor(deps), g, started, effects };
  }
  const changes: Array<[string, Partial<Command>]> = [
    ["env", { env: { CARGO_TERM_COLOR: "always" } }],
    ["cwd", { cwdRelative: "crate" }],
    ["timeout", { timeoutMs: 60_000 }],
    ["workspace", { executionWorkspaceId: "other-workspace" }],
    ["queue timeout", { queueTimeoutMs: 5_000 }],
  ];
  it.each(changes)("rejects changed %s rather than joining an in-flight different payload", async (_field, change) => {
    const l = legacy();
    const cmd = command("legacy-conflict");
    const first = track(l.executor.execute(cmd));
    await l.started.promise;
    const conflicting = track(l.executor.execute({ ...cmd, ...change }));
    l.g.release();
    await first.completion;
    expect(await conflicting.completion).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    expect(l.effects).toEqual([cmd.commandId]);
  });
  it.each(changes)("rejects changed %s rather than replaying a completed different payload", async (_field, change) => {
    const l = legacy();
    const cmd = command("legacy-replay-conflict");
    l.g.release();
    await l.executor.execute(cmd);
    expect(await settled(l.executor.execute({ ...cmd, ...change }))).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    expect(l.effects).toEqual([cmd.commandId]);
  });
  it.each([false, true])("equivalent reordered env keys join/replay identically (completed=%s)", async (completed) => {
    const l = legacy();
    const cmd = command("legacy-equivalent", { env: { CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "1" } });
    const first = track(l.executor.execute(cmd));
    await l.started.promise;
    if (completed) { l.g.release(); await first.completion; }
    const reordered = track(l.executor.execute({ ...cmd, env: { RUST_BACKTRACE: "1", CARGO_TERM_COLOR: "never" } }));
    l.g.release();
    expect(await reordered.completion).toEqual(await first.completion);
    expect(l.effects).toEqual([cmd.commandId]);
  });
});
