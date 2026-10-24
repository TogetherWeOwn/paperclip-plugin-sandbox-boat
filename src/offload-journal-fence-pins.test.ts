// Builder-owned regression pins for the round-1 delta fixes (PR #11).
// Not acceptance-owned. Existing handoff fixtures stay byte-identical; this new
// file pins each fix line so deleting it turns the suite red.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandDigest } from "./offload-journal.js";
import {
  FileStore, command, digest as normativeDigest, flush, harness, hostKey, record,
  settled, type Command, type Executor, type RecordV1,
} from "./test-support/durable-offload.js";

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

let root: string;
let h: ReturnType<typeof harness>;
let releases: Array<() => void>;
let pending: Promise<unknown>[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "offload-fence-pins-"));
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

// A cancel whose pre-fence store read returns stale pre-start bytes must not
// clobber a completed durable receipt. Pins the in-fence refresh.
class StaleSnapshotStore extends FileStore {
  private armed = false;
  private served = false;
  constructor(directory: string, readonly target: Command) { super(directory); }
  arm() { this.armed = true; this.served = false; }
  override async get(key: string): Promise<unknown> {
    if (this.armed && !this.served && key === hostKey(this.target)) {
      this.served = true;
      return structuredClone(record("syncing_in", this.target));
    }
    return await super.get(key);
  }
}

// A concurrent cancel committing between admission create and the queued fence
// must win. The overwrite models another journal instance racing the same disk.
// Pins the queued admission refresh.
class QueuedRaceStore extends FileStore {
  constructor(directory: string, readonly target: Command) { super(directory); }
  override async create(key: string, value: unknown): Promise<boolean> {
    const created = await super.create(key, value);
    if (created && key === hostKey(this.target)) {
      const refusal = record("not_started", this.target);
      await super.set(key, {
        ...refusal,
        result: {
          status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: this.target.commandId,
          remoteStarted: false, fallbackSafe: true, reason: "concurrent cancel",
        },
        resultAt: refusal.updatedAt,
      });
    }
    return created;
  }
}

// First scan fails, then heals. Pins clearing the cached startup promise.
class FlakyListStore extends FileStore {
  private calls = 0;
  override async list(prefix: string): Promise<string[]> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("INJECTED_TRANSIENT_LIST_FAILURE");
    return await super.list(prefix);
  }
}

describe("round-1 fence pins", () => {
  it("stale pre-start cancel bytes do not clobber a completed durable receipt", async () => {
    const cmd = command("stale-cancel");
    const first = h.openExecutor();
    const completed = await first.executor.execute(cmd);
    expect(completed).toMatchObject({ status: "completed", exitCode: 23 });
    expect(await disk(cmd)).toMatchObject({ state: "completed" });
    const attemptsBefore = h.attempts.length;

    const stale = new StaleSnapshotStore(h.hostDirectory, cmd);
    const second = h.openExecutor({ journalStore: stale });
    await second.executor.recover();
    stale.arm();
    const view = await second.executor.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "late");
    expect(view).toMatchObject({ state: "completed", remoteStarted: true, fallbackSafe: false });
    expect(view.result).toMatchObject({ exitCode: 23 });
    expect(await disk(cmd)).toMatchObject({ state: "completed", fallbackSafe: false });
    expect(h.attempts).toHaveLength(attemptsBefore);
    expect(await second.executor.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "late"))
      .toEqual(view);
    expect(await disk(cmd)).toMatchObject({ state: "completed" });
  });

  it("a refusal racing admission survives the queued fence without dispatch", async () => {
    const cmd = command("queued-race");
    const store = new QueuedRaceStore(h.hostDirectory, cmd);
    const { executor } = h.openExecutor({ journalStore: store });
    const result = await settled(executor.execute(cmd));
    expect(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(h.attempts, "a refusal that wins the fence must never dispatch").toHaveLength(0);
    expect(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
  });

  it("cross-instance cancel during sync.push fences the starting commit", async () => {
    const cmd = command("x-cancel-push");
    const pushing = gate();
    const releasePush = hold();
    const syncEffects: string[] = [];
    const { executor: runner } = h.openExecutor({
      sync: {
        push: async () => { syncEffects.push("push"); pushing.release(); await releasePush.promise; },
        collect: async () => { syncEffects.push("collect"); },
        stage: async () => { syncEffects.push("stage"); },
      },
    });
    const execution = track(runner.execute(cmd));
    await pushing.promise;
    expect(await disk(cmd)).toMatchObject({ state: "syncing_in" });

    const canceller = h.openExecutor().executor;
    const cancellation = await canceller.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
    expect(cancellation).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });

    releasePush.release();
    expect(await execution.completion).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    await h.advance(30_000);
    expect(h.attempts, "cancelled pre-start must never dispatch").toHaveLength(0);
    expect(syncEffects).toEqual(["push"]);
    expect(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
  });

  it("transient scan failure retries instead of wedging the journal", async () => {
    const store = new FlakyListStore(h.hostDirectory);
    const { executor } = h.openExecutor({ journalStore: store });
    const first = await settled(executor.recover());
    expect(first).toMatchObject({ rejected: expect.stringContaining("INJECTED_TRANSIENT_LIST_FAILURE") });
    await expect(executor.recover()).resolves.toBeUndefined();
    expect(await executor.execute(command("after-heal"))).toMatchObject({ status: "completed" });
    expect(h.attempts.map((attempt) => attempt.command.commandId)).toEqual(["after-heal"]);
  });

  it("mixed-case env keys digest by code-point order, not locale order", () => {
    // 'Z' sorts before 'a' by code point but after it under localeCompare in the
    // test runtime. Same-case fixtures cannot distinguish the two orderings.
    expect("Z" < "a").toBe(true);
    expect(Math.sign("Z".localeCompare("a"))).not.toBe(-1);
    const first = command("mixed-digest", { env: { Z: "1", a: "2" } });
    const reordered = command("mixed-digest", { env: { a: "2", Z: "1" } });
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)])) : value;
    const expected = createHash("sha256").update(JSON.stringify(canonical(first))).digest("hex");
    expect(commandDigest(first)).toBe(expected);
    expect(commandDigest(reordered)).toBe(expected);
    expect(normativeDigest(first)).toBe(expected);
    expect(normativeDigest(reordered)).toBe(expected);
  });

  it("same-instance cancel during sync_in still wins with zero transport", async () => {
    const cmd = command("same-cancel-push");
    const pushing = gate();
    const releasePush = hold();
    const { executor } = h.openExecutor({
      sync: {
        push: async () => { pushing.release(); await releasePush.promise; },
        collect: async () => {},
        stage: async () => {},
      },
    });
    const execution = track(executor.execute(cmd));
    await pushing.promise;
    expect(await disk(cmd)).toMatchObject({ state: "syncing_in" });
    const cancellation = await executor.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
    expect(cancellation).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    releasePush.release();
    expect(await execution.completion).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    await h.advance(30_000);
    expect(h.attempts).toHaveLength(0);
    expect(await disk(cmd)).toMatchObject({ state: "not_started", fallbackSafe: true });
    await vi.waitFor(async () => {
      expect(await disk(cmd)).toMatchObject({ state: "not_started" });
    }, { interval: 1 });
  });
});
