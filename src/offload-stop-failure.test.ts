import { describe, expect, it } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
import type { OffloadCommand, OffloadDeps, OffloadResult } from "./offload.js";
import { FakeBoat } from "./test-support/fake-boat.js";

const EPOCH = Date.parse("2026-10-23T10:00:00Z");
const completed = () => ({ exitCode: 0, seconds: 1 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function command(commandId: string): OffloadCommand {
  return {
    commandId,
    companyId: "company-1",
    runId: "run-1",
    cardId: "card-1",
    repoId: "repo-1",
    profileId: "rust-secret-free",
    argv: ["test", "--locked"],
  };
}

// Read-only diagnostics: never clear failures or mutate the pool to arrange a pass.
function diagnostics(executor: OffloadExecutor) {
  return executor as unknown as {
    stopFailures: Map<string, unknown>;
    journal: Map<string, { result: OffloadResult | null }>;
    pool: Array<{ sandboxId: string; busy: boolean; stopped: boolean; quarantined: boolean }>;
  };
}

function setup(runCommand: OffloadDeps["runCommand"] = async () => completed()) {
  const clock = { t: EPOCH };
  const now = () => clock.t;
  const fake = new FakeBoat({ now });
  const timers = new Map<number, { at: number; cb: () => void }>();
  let serial = 0;
  const set = (cb: () => void, ms: number) => {
    const id = ++serial;
    timers.set(id, { at: clock.t + ms, cb });
    return id;
  };
  const clear = (handle: unknown) => { timers.delete(handle as number); };
  const advance = async (ms: number) => {
    const target = clock.t + ms;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      clock.t = next[1].at;
      next[1].cb();
      await flush();
    }
    clock.t = target;
    await flush();
  };
  const starts: Array<{ sandboxId: string; commandId: string }> = [];
  const executor = new OffloadExecutor({
    boat: fake as unknown as BoatApiLike,
    logger: { info() {}, warn() {}, error() {} },
    now,
    timers: { set, clear },
    config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0 },
    runCommand: async (sandboxId, cmd) => {
      starts.push({ sandboxId, commandId: cmd.commandId });
      return runCommand(sandboxId, cmd);
    },
  });
  return { executor, clock, fake, timers, advance, starts };
}

async function failIdleStop(s: ReturnType<typeof setup>) {
  const receipt = await s.executor.execute(command("cmd-1"));
  expect(receipt.status).toBe("completed");
  if (receipt.status !== "completed") throw new Error("expected completed first command");
  s.fake.failNext("stop", new Error("transient idle stop failure"));
  await s.advance(14_999);
  expect(s.fake.callsOf("stop")).toHaveLength(0);
  await s.advance(1);
  expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([receipt.sandboxId]);
  expect(s.fake.boxes.get(receipt.sandboxId)?.state).toBe("ready");
  expect([...s.timers.values()].map((timer) => timer.at - s.clock.t)).toEqual([1_000]);
  expect(diagnostics(s.executor).stopFailures.has(receipt.sandboxId)).toBe(true);
  return receipt.sandboxId;
}

// These regressions catch failure state outliving its idle-stop obligation.
// The controls also reject fixes that suppress real shutdown errors or stop an
// uncertain VM just to clear the failure ledger.
describe("offload stop-failure ownership", () => {
  it("resolves repeated shutdown after reuse quarantines a VM with an old idle-stop failure", async () => {
    const s = setup(async (_sandboxId, cmd) => {
      if (cmd.commandId === "cmd-2") throw new Error("transport dropped after possible remote start");
      return completed();
    });
    const sandboxId = await failIdleStop(s);

    // Reuse at 15s, before the failed idle stop's retry at 16s.
    const unknown = await s.executor.execute(command("cmd-2"));
    expect(unknown).toMatchObject({
      status: "unknown", commandId: "cmd-2", sandboxId,
      remoteStarted: true, fallbackSafe: false, exitCode: 75,
    });
    expect(s.starts).toEqual([
      { sandboxId, commandId: "cmd-1" },
      { sandboxId, commandId: "cmd-2" },
    ]);
    expect(diagnostics(s.executor).pool.find((vm) => vm.sandboxId === sandboxId))
      .toMatchObject({ quarantined: true, busy: false, stopped: false });
    expect(diagnostics(s.executor).journal.get("cmd-2")?.result).toEqual(unknown);

    // Quarantine consumes the only slot; a new ID must not reuse or replace it.
    expect(await s.executor.execute(command("cmd-3"))).toMatchObject({
      status: "unavailable", remoteStarted: false, fallbackSafe: true,
    });
    await s.advance(1_000);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
    expect(s.timers.size).toBe(0);

    // Soft assertions witness both calls even when the first incorrectly rejects.
    await expect.soft(s.executor.shutdown()).resolves.toBeUndefined();
    await expect.soft(s.executor.shutdown()).resolves.toBeUndefined();
    expect(await s.executor.execute(command("cmd-2"))).toEqual(unknown);
    expect(diagnostics(s.executor).journal.get("cmd-2")?.result).toEqual(unknown);
    expect(s.executor.getUsage().filter((row) => row.commandId === "cmd-2"))
      .toMatchObject([{ commandId: "cmd-2", sandboxId, outcome: "unknown", exitCode: 75 }]);

    await s.advance(60_000);
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId]);
    expect(s.fake.callsOf("resume")).toHaveLength(0);
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.starts).toHaveLength(2);
    expect(s.fake.boxes.get(sandboxId)?.state).toBe("ready");
    expect(diagnostics(s.executor).pool.find((vm) => vm.sandboxId === sandboxId))
      .toMatchObject({ quarantined: true, stopped: false });
    expect(s.timers.size).toBe(0);
  });

  it("invalidates the old stop failure as soon as reuse reserves the still-active VM", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = setup(async (_sandboxId, cmd) => {
      if (cmd.commandId === "cmd-2") await gate;
      return completed();
    });
    const sandboxId = await failIdleStop(s);
    const active = s.executor.execute(command("cmd-2"));
    await flush();

    expect(s.starts).toEqual([
      { sandboxId, commandId: "cmd-1" },
      { sandboxId, commandId: "cmd-2" },
    ]);
    expect(diagnostics(s.executor).pool.find((vm) => vm.sandboxId === sandboxId))
      .toMatchObject({ busy: true, stopped: false, quarantined: false });
    expect.soft(diagnostics(s.executor).stopFailures.has(sandboxId)).toBe(false);
    expect.soft(s.timers.size).toBe(0);
    await s.advance(1_000);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(1);
    expect.soft(diagnostics(s.executor).stopFailures.has(sandboxId)).toBe(false);

    release();
    expect(await active).toMatchObject({ status: "completed", sandboxId, warm: "warm" });
    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId, sandboxId]);
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.callsOf("resume")).toHaveLength(0);
    expect(s.fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(s.timers.size).toBe(0);
  });

  it("reports a fresh shutdown stop failure until a later shutdown retry actually succeeds", async () => {
    const s = setup();
    const receipt = await s.executor.execute(command("fresh-shutdown"));
    expect(receipt.status).toBe("completed");
    if (receipt.status !== "completed") throw new Error("expected completed command");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      s.fake.failNext("stop", new Error("fresh shutdown stop failure"));
      await expect(s.executor.shutdown()).rejects.toThrow(/OFFLOAD_SHUTDOWN_INCOMPLETE/);
      expect(s.fake.callsOf("stop")).toHaveLength(attempt);
      expect(s.fake.boxes.get(receipt.sandboxId)?.state).toBe("ready");
      expect(diagnostics(s.executor).stopFailures.has(receipt.sandboxId)).toBe(true);
      expect(s.timers.size).toBe(0);
    }

    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId))
      .toEqual([receipt.sandboxId, receipt.sandboxId, receipt.sandboxId]);
    expect(s.fake.boxes.get(receipt.sandboxId)?.state).toBe("archived");
    expect(diagnostics(s.executor).stopFailures.has(receipt.sandboxId)).toBe(false);
    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    await s.advance(60_000);
    expect(s.fake.callsOf("stop")).toHaveLength(3);
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.callsOf("resume")).toHaveLength(0);
    expect(s.timers.size).toBe(0);
  });

  it("clears a current idle-stop failure only after its scheduled retry succeeds", async () => {
    const s = setup();
    const sandboxId = await failIdleStop(s);
    await s.advance(999);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
    expect(diagnostics(s.executor).stopFailures.has(sandboxId)).toBe(true);
    await s.advance(1);
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId, sandboxId]);
    expect(s.fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(diagnostics(s.executor).stopFailures.has(sandboxId)).toBe(false);
    expect(s.timers.size).toBe(0);
    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    expect(s.fake.callsOf("stop")).toHaveLength(2);
  });
});
