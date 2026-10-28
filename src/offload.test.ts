import { describe, expect, it, beforeEach } from "vitest";
import { FakeBoat, trialLimits } from "./test-support/fake-boat.js";
import type { BoatApiLike } from "./boat-client.js";
import { JsonState, usage } from "./test-support/account-admission.fixture.js";

// RED: this module does not exist yet. These tests define the v1 offload
// executor contract from TOG-38024: shared pool, warm pick, resume/create,
// idle stop after C, queueing, budget fallback, usage + expected-cost log.
import { OffloadExecutor } from "./offload.js";
import type { OffloadCommand } from "./offload.js";

interface FakeTimer {
  id: number;
  at: number;
  cb: () => void;
}

let nextAccount = 0;

function testSetup() {
  const account = { state: new JsonState(), accountId: `legacy-offload-account-${++nextAccount}`, poolId: "legacy-offload" };
  const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
  const now = () => clock.t;
  const fake = new FakeBoat({ now });
  let timerId = 0;
  const timers = new Map<number, FakeTimer>();
  const set = (cb: () => void, ms: number) => {
    timerId += 1;
    timers.set(timerId, { id: timerId, at: clock.t + ms, cb });
    return timerId;
  };
  const clear = (handle: unknown) => {
    timers.delete(handle as number);
  };
  const advance = async (ms: number) => {
    const target = clock.t + ms;
    // Fire timers in deadline order, advancing the clock to each deadline.
    for (;;) {
      let next: FakeTimer | null = null;
      for (const timer of timers.values()) {
        if (timer.at <= target && (!next || timer.at < next.at)) next = timer;
      }
      if (!next) break;
      timers.delete(next.id);
      clock.t = next.at;
      next.cb();
      // Let any promise continuations (stop calls) run.
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    clock.t = target;
  };
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, meta?: Record<string, unknown>) => {
      logs.push({ level: "info", message, meta });
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      logs.push({ level: "warn", message, meta });
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      logs.push({ level: "error", message, meta });
    },
  };
  return { account, clock, now, fake, timers, set, clear, advance, logs, logger };
}

function cmd(partial: Partial<OffloadCommand> & { commandId: string }): OffloadCommand {
  return {
    companyId: "company-1",
    runId: "run-1",
    cardId: "card-1",
    repoId: "repo-1",
    profileId: "rust-secret-free",
    argv: ["test", "--locked"],
    ...partial,
  };
}

describe("offload executor", () => {
  let setup: ReturnType<typeof testSetup>;

  beforeEach(() => {
    setup = testSetup();
  });

  it("reuses the warmest idle VM without a new start", async () => {
    const { fake, logger, now, set, clear } = setup;
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 2 }),
    });
    const first = await executor.execute(cmd({ commandId: "cmd-1" }));
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("expected completed");
    expect(first.warm).toBe("cold");
    const firstVm = first.sandboxId;
    expect(fake.callsOf("create")).toHaveLength(1);

    const second = await executor.execute(cmd({ commandId: "cmd-2" }));
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.sandboxId).toBe(firstVm);
    expect(second.warm).toBe("warm");
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("resume")).toHaveLength(0);
    await executor.shutdown();
  });

  it("counts one cold start for the first command", async () => {
    const { fake, logger, now, set, clear } = setup;
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 1 }),
    });
    const result = await executor.execute(cmd({ commandId: "cmd-cold-1" }));
    expect(result.status).toBe("completed");
    expect(fake.callsOf("create")).toHaveLength(1);
    await executor.shutdown();
  });

  it("stops the VM C seconds after the last command ends", async () => {
    const { fake, logger, now, set, clear, advance } = setup;
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 1 }),
    });
    await executor.execute(cmd({ commandId: "cmd-stop-1" }));
    expect(fake.callsOf("stop")).toHaveLength(0);
    await advance(15_000);
    expect(fake.callsOf("stop")).toHaveLength(1);
    await executor.shutdown();
  });

  it("never stops a VM while a command runs", async () => {
    const { fake, logger, now, set, clear, advance } = setup;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => {
        await gate;
        return { exitCode: 0, seconds: 5 };
      },
    });
    const pending = executor.execute(cmd({ commandId: "cmd-busy-1" }));
    // Let the command start.
    await new Promise((resolve) => setImmediate(resolve));
    await advance(30_000);
    expect(fake.callsOf("stop")).toHaveLength(0);
    release();
    const result = await pending;
    expect(result.status).toBe("completed");
    await advance(15_000);
    expect(fake.callsOf("stop")).toHaveLength(1);
    await executor.shutdown();
  });

  it("runs up to the max concurrently, then queues FIFO", async () => {
    const { fake, logger, now, set, clear } = setup;
    const releases = new Map<string, () => void>();
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 2, offloadIdleStopSeconds: 60 },
      runCommand: async (_sandboxId, command) => {
        await new Promise<void>((resolve) => {
          releases.set(command.commandId, resolve);
        });
        return { exitCode: 0, seconds: 1 };
      },
    });
    const p1 = executor.execute(cmd({ commandId: "cmd-q-1" }));
    const p2 = executor.execute(cmd({ commandId: "cmd-q-2" }));
    // Let both start.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.callsOf("create")).toHaveLength(2);
    const p3 = executor.execute(cmd({ commandId: "cmd-q-3" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // Queued: no third VM.
    expect(fake.callsOf("create")).toHaveLength(2);
    // Finish the first; the queued command reuses its VM.
    releases.get("cmd-q-1")!();
    const r1 = await p1;
    const r3 = await (async () => {
      // Give the queue a tick to dispatch before releasing q2.
      await new Promise((resolve) => setImmediate(resolve));
      releases.get("cmd-q-3")!();
      return await p3;
    })();
    releases.get("cmd-q-2")!();
    const r2 = await p2;
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    expect(r3.status).toBe("completed");
    if (r1.status !== "completed" || r3.status !== "completed") throw new Error("expected completed");
    expect(r3.sandboxId).toBe(r1.sandboxId);
    expect(r3.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(fake.callsOf("create")).toHaveLength(2);
    await executor.shutdown();
  });

  it("returns OFFLOAD_UNAVAILABLE when starts or compute run low, without starting", async () => {
    const { fake, logger, now, set, clear } = setup;
    fake.limitsResponse = trialLimits({ starts: { day: { limit: 75, remaining: 0, used: 75 }, hour: { limit: 25, remaining: 25, used: 0 }, minute: { limit: 5, remaining: 5, used: 0 }, unlimited: false } });
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 1 }),
    });
    const result = await executor.execute(cmd({ commandId: "cmd-budget-1" }));
    expect(result).toMatchObject({ status: "unavailable", code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true, remoteStarted: false });
    expect(fake.callsOf("create")).toHaveLength(0);
    expect(fake.callsOf("resume")).toHaveLength(0);
    await executor.shutdown();
  });

  it("fails closed when limits are unreadable", async () => {
    const { fake, logger, now, set, clear } = setup;
    fake.failNext("limits", new Error("limits down"));
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 1 }),
    });
    const result = await executor.execute(cmd({ commandId: "cmd-limits-down" }));
    expect(result).toMatchObject({ status: "unavailable", code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true });
    expect(fake.callsOf("create")).toHaveLength(0);
    await executor.shutdown();
  });

  it("persists pending usage per command and logs an expected-cost line", async () => {
    const { fake, logger, now, set, clear, logs } = setup;
    fake.usage = async () => { throw new Error("synthetic meter unavailable"); };
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => { setup.clock.t += 63_000; return { exitCode: 0, seconds: 63 }; },
    });
    const result = await executor.execute(cmd({ commandId: "cmd-usage-1", runId: "run-9", cardId: "card-9" }));
    expect(result.status).toBe("completed");
    const rows = usage(executor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commandId: "cmd-usage-1", runId: "run-9", cardId: "card-9", warm: "cold",
      kind: "command", usageRecordId: expect.any(String), meterProvenance: "pending", queueWaitMs: expect.any(Number) });
    expect(rows[0]!.usageRecordId.length).toBeGreaterThan(0);
    expect(typeof rows[0]!.seconds).toBe("number");
    expect(typeof rows[0]!.dollars).toBe("number");
    expect(rows[0]!.sandboxId).toMatch(/^bx_/);
    const costLine = logs.find((entry) => entry.message.includes("expected-cost"));
    expect(costLine).toBeDefined();
    expect(String(costLine!.message)).toMatch(/expected-cost/);
    // No secrets in the cost line.
    expect(JSON.stringify(costLine)).not.toMatch(/sk-/);
    await executor.shutdown();
    expect(usage(executor)).toMatchObject([{ usageRecordId: rows[0]!.usageRecordId, meterProvenance: "pending" }]);
  });

  it("cancels a pending idle stop when a new command reserves the VM", async () => {
    const { fake, logger, now, set, clear, advance } = setup;
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 1 }),
    });
    await executor.execute(cmd({ commandId: "cmd-cancel-1" }));
    await advance(10_000);
    expect(fake.callsOf("stop")).toHaveLength(0);
    await executor.execute(cmd({ commandId: "cmd-cancel-2" }));
    // The first timer must not stop the VM out from under the second command's tail.
    await advance(10_000);
    expect(fake.callsOf("stop")).toHaveLength(0);
    await advance(5_000);
    expect(fake.callsOf("stop")).toHaveLength(1);
    await executor.shutdown();
  });

  it("does not run the same commandId twice for the same payload", async () => {
    const { fake, logger, now, set, clear } = setup;
    let runs = 0;
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 60 },
      runCommand: async () => {
        runs += 1;
        return { exitCode: 0, seconds: 1 };
      },
    });
    const first = await executor.execute(cmd({ commandId: "cmd-idem-1" }));
    const second = await executor.execute(cmd({ commandId: "cmd-idem-1" }));
    expect(first).toEqual(second);
    expect(runs).toBe(1);
    await executor.shutdown();
  });

  it("records the duration of a completed remote node command", async () => {
    const { fake, logger, now, set, clear } = setup;
    const recorded: Array<{ command: OffloadCommand; seconds: number }> = [];
    const executor = new OffloadExecutor({
      ...setup.account,
      boat: fake as unknown as BoatApiLike,
      logger,
      now,
      timers: { set, clear },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15 },
      runCommand: async () => ({ exitCode: 0, seconds: 42 }),
      recordDuration: async (command, seconds) => {
        recorded.push({ command, seconds });
      },
    });
    const result = await executor.execute(cmd({ commandId: "cmd-duration-1",
      tool: "node", runner: "npm", profileId: "node-public-1", argv: ["run", "test"] }));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.seconds).toBe(result.seconds);
    expect(recorded[0]!.seconds).toBe(42);
    expect(recorded[0]!.command.commandId).toBe("cmd-duration-1");
    await executor.shutdown();
  });
});

describe("offload driver config", () => {
  it("defaults to a 4-VM pool with a 15 s idle stop", async () => {
    const { parseDriverConfig } = await import("./config.js");
    expect(parseDriverConfig({})).toMatchObject({ maxOffloadVms: 4, offloadIdleStopSeconds: 15 });
  });

  it("declares the pool settings in the manifest schema", async () => {
    const { default: manifest } = await import("./manifest.js");
    const props = (manifest.environmentDrivers?.[0] as { configSchema?: { properties?: Record<string, unknown> } }).configSchema?.properties ?? {};
    expect(props.maxOffloadVms).toMatchObject({ default: 4 });
    expect(props.offloadIdleStopSeconds).toMatchObject({ default: 15 });
  });
});
