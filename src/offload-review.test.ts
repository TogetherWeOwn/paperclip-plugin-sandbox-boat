import { afterEach, describe, expect, it } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
import type { OffloadCommand, OffloadDeps, OffloadResult } from "./offload.js";
import { FakeBoat } from "./test-support/fake-boat.js";

const SECRET_CANARY = "sk-offload-review-secret-canary";
const EPOCH = Date.parse("2026-10-23T10:00:00Z");
const completed = (seconds = 1) => ({ exitCode: 0, seconds });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Flush async API continuations without sleeping or advancing the test clock.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function command(commandId: string, partial: Partial<OffloadCommand> = {}): OffloadCommand {
  return {
    commandId,
    companyId: "company-1",
    runId: "run-1",
    cardId: "card-1",
    repoId: "repo-1",
    profileId: "rust-secret-free",
    argv: ["test", "--locked"],
    ...partial,
  };
}

// Only the explicitly supported journal/pool diagnostics cross the API boundary.
function diagnostics(executor: OffloadExecutor) {
  return executor as unknown as {
    journal: Map<string, { digest: string; result: OffloadResult | null }>;
    pool: Array<{
      sandboxId: string;
      busy: boolean;
      stopped: boolean;
      quarantined?: boolean;
      lastActiveAt: number;
    }>;
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(
  runCommand: OffloadDeps["runCommand"] = async () => completed(),
  config: Partial<OffloadDeps["config"]> = {},
) {
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
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const log = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    logs.push({ level, message, meta });
  };
  const logger = { info: log("info"), warn: log("warn"), error: log("error") };
  const starts: Array<{ sandboxId: string; commandId: string }> = [];
  const executor = new OffloadExecutor({
    boat: fake as unknown as BoatApiLike,
    logger,
    now,
    timers: { set, clear },
    config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, ...config },
    runCommand: async (sandboxId, cmd) => {
      starts.push({ sandboxId, commandId: cmd.commandId });
      return runCommand(sandboxId, cmd);
    },
  });
  cleanups.push(() => { timers.clear(); });
  return { executor, clock, fake, timers, advance, logs, starts };
}

function expectNotStarted(executor: OffloadExecutor, id: string, result: unknown) {
  expect(result).toMatchObject({
    status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: id,
    remoteStarted: false, fallbackSafe: true,
  });
  expect(diagnostics(executor).journal.get(id)?.result).toEqual(result);
  expect(executor.getUsage().filter((row) => row.commandId === id)).toEqual([]);
}

function numericLagFields(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    /lag.*ms|ms.*lag/i.test(key) && typeof child === "number"
      ? [child]
      : numericLagFields(child));
}

function expectedCostPayload(entry: { message: string; meta?: Record<string, unknown> }) {
  const jsonAt = entry.message.indexOf("{");
  return {
    ...(jsonAt >= 0 ? JSON.parse(entry.message.slice(jsonAt)) : {}),
    ...entry.meta,
  } as Record<string, unknown>;
}

describe("offload review: in-flight command identity", () => {
  it.each([1, 4])("joins concurrent duplicates with %i VM slots and queueLimit=0", async (maxOffloadVms) => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async () => gate.promise, { maxOffloadVms, queueLimit: 0 });
    const payload = command("duplicate");
    const first = s.executor.execute(payload);
    const second = s.executor.execute({ ...payload, argv: [...payload.argv] });
    await flush();
    // A duplicate is a receipt subscriber, not another queue admission or spawn.
    expect.soft(s.starts).toHaveLength(1);
    expect.soft(s.fake.callsOf("create")).toHaveLength(1);
    gate.resolve(completed(5));
    const results = await Promise.all([first, second]);
    expect.soft(results[0]).toMatchObject({ status: "completed", seconds: 5 });
    expect.soft(results[1]).toEqual(results[0]);
    expect.soft(s.executor.getUsage()).toHaveLength(1);
    expect.soft(diagnostics(s.executor).journal.get("duplicate")?.result).toEqual(results[0]);
    expect.soft(await s.executor.execute(payload)).toEqual(results[0]);
    expect(s.starts).toHaveLength(1);
  });

  it("joins an already running duplicate even when the queue is full", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async () => gate.promise, { queueLimit: 0 });
    const first = s.executor.execute(command("running-duplicate"));
    await flush();
    const second = s.executor.execute(command("running-duplicate"));
    await flush();
    gate.resolve(completed(5));
    const receipts = await Promise.all([first, second]);
    expect.soft(receipts[0]).toMatchObject({ status: "completed", seconds: 5 });
    expect.soft(receipts[1]).toEqual(receipts[0]);
    expect(s.starts).toHaveLength(1);
    expect(s.executor.getUsage()).toHaveLength(1);
  });

  it.each(["in-flight", "terminal"])("rejects a conflicting digest for an %s command ID", async (phase) => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async () => gate.promise, { maxOffloadVms: 4 });
    const first = s.executor.execute(command("conflict"));
    await flush();
    if (phase === "terminal") {
      gate.resolve(completed());
      await first;
    }
    const conflict = s.executor.execute(command("conflict", { argv: ["test", "--different"] }));
    await expect(conflict).rejects.toThrow(/payload|digest|conflict|different/i);
    gate.resolve(completed());
    const receipt = await first;
    expect(await s.executor.execute(command("conflict"))).toEqual(receipt);
    expect(s.starts).toHaveLength(1);
    expect(s.executor.getUsage()).toHaveLength(1);
  });
});

describe("offload review: queue reservation and selection", () => {
  // Sweep real Promise interleavings around release. No queue resolver/private
  // method is replaced: newcomers arrive on successive microtask boundaries.
  it.each(Array.from({ length: 13 }, (_, turn) => turn))(
    "reserves a handed-off VM before a newcomer at microtask boundary %i",
    async (turn) => {
      const gate = deferred<ReturnType<typeof completed>>();
      const s = setup(async (_vm, cmd) => cmd.commandId === "holder" ? gate.promise : completed());
      const holder = s.executor.execute(command("holder"));
      await flush();
      const queued = s.executor.execute(command("queued"));
      await flush();
      gate.resolve(completed());
      for (let i = 0; i < turn; i += 1) await Promise.resolve();
      const newcomer = s.executor.execute(command("newcomer"));
      const results = await Promise.all([holder, queued, newcomer]);
      expect(results.map((result) => result.status)).toEqual(["completed", "completed", "completed"]);
      expect(s.starts.map((start) => start.commandId)).toEqual(["holder", "queued", "newcomer"]);
      expect(new Set(s.starts.map((start) => start.sandboxId)).size).toBe(1);
      expect(s.fake.callsOf("create")).toHaveLength(1);
    },
  );

  it("dispatches three waiting commands FIFO rather than LIFO", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => cmd.commandId === "holder" ? gate.promise : completed());
    const holder = s.executor.execute(command("holder"));
    await flush();
    const waiters = [];
    for (const id of ["first", "second", "third"]) {
      waiters.push(s.executor.execute(command(id)));
      await flush();
    }
    expect(s.starts.map((start) => start.commandId)).toEqual(["holder"]);
    gate.resolve(completed());
    await Promise.all([holder, ...waiters]);
    expect(s.starts.map((start) => start.commandId)).toEqual(["holder", "first", "second", "third"]);
    expect(s.fake.callsOf("create")).toHaveLength(1);
  });

  it("chooses the most recently active of two idle VMs", async () => {
    const oldGate = deferred<ReturnType<typeof completed>>();
    const newGate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => {
      if (cmd.commandId === "older") return oldGate.promise;
      if (cmd.commandId === "newer") return newGate.promise;
      return completed();
    }, { maxOffloadVms: 2 });
    const older = s.executor.execute(command("older"));
    const newer = s.executor.execute(command("newer"));
    await flush();
    expect(s.starts).toHaveLength(2);
    await s.advance(1_000);
    oldGate.resolve(completed());
    const oldReceipt = await older;
    await s.advance(1_000);
    newGate.resolve(completed());
    const newReceipt = await newer;
    expect(oldReceipt.status).toBe("completed");
    expect(newReceipt.status).toBe("completed");
    if (oldReceipt.status !== "completed" || newReceipt.status !== "completed") return;
    expect(oldReceipt.sandboxId).not.toBe(newReceipt.sandboxId);
    expect(diagnostics(s.executor).pool.every((vm) => !vm.busy)).toBe(true);
    const picked = await s.executor.execute(command("warm-pick"));
    expect(picked).toMatchObject({ status: "completed", sandboxId: newReceipt.sandboxId, warm: "warm" });
    expect(s.fake.callsOf("create")).toHaveLength(2);
    expect(s.fake.callsOf("resume")).toHaveLength(0);
  });
});

describe("offload review: idle stop recovery", () => {
  it("retries at 1s exponential backoff capped at 30s and records sanitized warnings and stop lag", async () => {
    const s = setup();
    const receipt = await s.executor.execute(command("idle-retry"));
    expect(receipt.status).toBe("completed");
    if (receipt.status !== "completed") return;
    for (let i = 0; i < 7; i += 1) {
      s.fake.failNext("stop", new Error(`Authorization: Bearer ${SECRET_CANARY}`));
    }
    // Initial idle deadline, then retry intervals 1, 2, 4, 8, 16, 30, 30 seconds.
    let attempts = 0;
    for (const delay of [15_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await s.advance(delay - 1);
      expect.soft(s.fake.callsOf("stop")).toHaveLength(attempts);
      await s.advance(1);
      attempts += 1;
      expect.soft(s.fake.callsOf("stop")).toHaveLength(attempts);
    }
    expect.soft(s.fake.boxes.get(receipt.sandboxId)?.state).toBe("archived");
    expect.soft(s.logs.filter((entry) => entry.level === "warn")).toHaveLength(7);
    expect.soft(JSON.stringify(s.logs)).not.toContain(SECRET_CANARY);
    expect.soft(JSON.stringify(s.logs.filter((entry) => entry.level === "warn"))).toContain(receipt.sandboxId);
    const lagLogs = s.logs.filter((entry) => entry.level === "info");
    expect.soft(numericLagFields(lagLogs)).toContain(91_000);
    expect(s.timers.size).toBe(0);
  });

  it("cancels a failed-stop retry when a new reservation takes the VM", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => cmd.commandId === "new-work" ? gate.promise : completed());
    const first = await s.executor.execute(command("old-work"));
    s.fake.failNext("stop", new Error("transient stop failure"));
    await s.advance(15_000);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(1);
    expect.soft(s.timers.size).toBe(1);
    const running = s.executor.execute(command("new-work"));
    await flush();
    expect(s.starts[1]?.sandboxId).toBe(s.starts[0]?.sandboxId);
    await s.advance(2_000);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(1);
    gate.resolve(completed());
    const second = await running;
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    await s.advance(14_999);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
    await s.advance(1);
    expect(s.fake.callsOf("stop")).toHaveLength(2);
    expect(s.timers.size).toBe(0);
  });
});

describe("offload review: uncertain remote execution", () => {
  function uncertain() {
    const s = setup(async () => {
      s.clock.t += 7_000;
      throw new Error(`SSH dropped after possible start: ${SECRET_CANARY}`);
    }, { queueLimit: 0 });
    // Turn rejection into inspectable evidence, not an unhandled test error.
    const execute = () => s.executor.execute(command("uncertain")).catch((error: unknown) => ({
      status: "rejected", error: String(error),
    }));
    return { ...s, execute };
  }

  it("returns an unknown receipt with exitCode 75 and no safe fallback after a possible start", async () => {
    const s = uncertain();
    expect(await s.execute()).toMatchObject({
      status: "unknown", commandId: "uncertain", remoteStarted: true,
      fallbackSafe: false, exitCode: 75,
    });
  });

  it("retains the same unknown receipt and never reruns the same ID", async () => {
    const s = uncertain();
    const first = await s.execute();
    const second = await s.execute();
    expect.soft(first).toMatchObject({ status: "unknown" });
    expect.soft(second).toEqual(first);
    expect.soft(diagnostics(s.executor).journal.get("uncertain")?.result).toEqual(first);
    expect(s.starts).toHaveLength(1);
  });

  it("quarantines an uncertain VM without stopping or reusing it, including on shutdown", async () => {
    const s = uncertain();
    await s.execute();
    const id = s.starts[0]!.sandboxId;
    expect.soft(diagnostics(s.executor).pool.find((vm) => vm.sandboxId === id)).toMatchObject({ quarantined: true });
    const next = await s.executor.execute(command("not-on-uncertain-vm")).catch((error: unknown) => ({
      status: "rejected", error: String(error),
    }));
    expect.soft(next).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true });
    expect.soft(s.starts).toHaveLength(1);
    await s.advance(120_000);
    await s.executor.shutdown();
    expect.soft(s.fake.callsOf("stop")).toHaveLength(0);
    expect.soft(s.fake.callsOf("resume")).toHaveLength(0);
    expect.soft(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.boxes.get(id)?.state).toBe("ready");
  });

  it("retains elapsed usage and cost for unknown execution without logging argv or transport secrets", async () => {
    const s = uncertain();
    await s.execute();
    const rows = s.executor.getUsage();
    expect.soft(rows).toHaveLength(1);
    expect.soft(rows[0]).toMatchObject({
      commandId: "uncertain", outcome: "unknown", seconds: 7, dollars: 0.00007,
      queueWaitMs: 0, exitCode: 75, sandboxId: s.starts[0]!.sandboxId,
    });
    expect.soft(s.logs.some((entry) => entry.message.includes("expected-cost"))).toBe(true);
    expect(JSON.stringify(s.logs)).not.toContain(SECRET_CANARY);
  });
});

describe("offload review: shutdown lifecycle", () => {
  it("fences new execution and journals a safe not-started receipt", async () => {
    const s = setup();
    await s.executor.shutdown();
    const result = await s.executor.execute(command("after-shutdown"));
    expectNotStarted(s.executor, "after-shutdown", result);
    expect(s.starts).toEqual([]);
    expect(s.fake.callsOf("create")).toHaveLength(0);
    expect(await s.executor.execute(command("after-shutdown"))).toEqual(result);
  });

  it("stops idle VMs immediately rather than merely cancelling their timers", async () => {
    const s = setup();
    const result = await s.executor.execute(command("idle-at-shutdown"));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    await s.executor.shutdown();
    expect.soft(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([result.sandboxId]);
    expect.soft(s.fake.boxes.get(result.sandboxId)?.state).toBe("archived");
    expect(s.timers.size).toBe(0);
    await s.advance(60_000);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
  });

  it("journals queued shutdown receipts, drains active work, and stops without new idle timers", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async () => gate.promise);
    const active = s.executor.execute(command("active-at-shutdown"));
    await flush();
    const queued = s.executor.execute(command("queued-at-shutdown"));
    await flush();
    let drained = false;
    const shutdown = s.executor.shutdown().then(() => { drained = true; });
    await flush();
    const queuedResult = await queued;
    expect.soft(queuedResult).toMatchObject({
      status: "unavailable", remoteStarted: false, fallbackSafe: true,
    });
    expect.soft(diagnostics(s.executor).journal.get("queued-at-shutdown")?.result).toEqual(queuedResult);
    expect.soft(drained).toBe(false);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(0);
    await s.advance(60_000);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(0);
    gate.resolve(completed(60));
    expect(await active).toMatchObject({ status: "completed" });
    await shutdown;
    expect.soft(s.starts.map((start) => start.commandId)).toEqual(["active-at-shutdown"]);
    expect.soft(s.fake.callsOf("stop")).toHaveLength(1);
    expect.soft(s.timers.size).toBe(0);
    const replay = await s.executor.execute(command("queued-at-shutdown"));
    expect.soft(replay).toEqual(queuedResult);
    await s.advance(60_000);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
  });
});

describe("offload review: bounded queue and exact accounting", () => {
  it("labels completed usage separately from unknown execution", async () => {
    const s = setup();
    await s.executor.execute(command("known-completion"));
    expect(s.executor.getUsage()).toMatchObject([{ commandId: "known-completion", outcome: "completed" }]);
  });

  it("journals queue-full fallback and never executes that ID after capacity returns", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => cmd.commandId === "holder" ? gate.promise : completed(), { queueLimit: 1 });
    const active = s.executor.execute(command("holder"));
    await flush();
    const queued = s.executor.execute(command("accepted-waiter"));
    await flush();
    let rejected: OffloadResult | undefined;
    const overflow = s.executor.execute(command("overflow")).then((result) => { rejected = result; return result; });
    await flush();
    expect.soft(rejected).toMatchObject({ status: "unavailable", fallbackSafe: true, remoteStarted: false });
    if (rejected) expectNotStarted(s.executor, "overflow", rejected);
    gate.resolve(completed());
    await Promise.all([active, queued, overflow]);
    const replay = await s.executor.execute(command("overflow"));
    expect.soft(replay).toEqual(rejected);
    expect(s.starts.map((start) => start.commandId)).toEqual(["holder", "accepted-waiter"]);
    expect(s.fake.callsOf("create")).toHaveLength(1);
  });

  it("times out at the command deadline, journals safe fallback, and never dispatches an expired waiter", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => cmd.commandId === "holder" ? gate.promise : completed(), { queueTimeoutMs: 1_000 });
    const active = s.executor.execute(command("holder"));
    await flush();
    let expired: OffloadResult | undefined;
    const waiter = s.executor.execute(command("expires", { queueTimeoutMs: 100 }))
      .then((result) => { expired = result; return result; });
    await flush();
    await s.advance(99);
    expect.soft(expired).toBeUndefined();
    await s.advance(1);
    expect.soft(expired).toMatchObject({ status: "unavailable", fallbackSafe: true, remoteStarted: false });
    if (expired) expectNotStarted(s.executor, "expires", expired);
    gate.resolve(completed());
    await Promise.all([active, waiter]);
    await s.advance(5_000);
    expect.soft(await s.executor.execute(command("expires", { queueTimeoutMs: 100 }))).toEqual(expired);
    expect(s.starts.map((start) => start.commandId)).toEqual(["holder"]);
    expect(s.fake.callsOf("create")).toHaveLength(1);
  });

  it("records exact 63s/default-rate dollars and 1375ms queue wait in usage, receipt, and cost JSON", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const s = setup(async (_vm, cmd) => cmd.commandId === "holder" ? gate.promise : completed(63));
    const holder = s.executor.execute(command("holder"));
    await flush();
    const pending = s.executor.execute(command("accounted", {
      runId: "run-9", cardId: "card-9", argv: ["test", `--token=${SECRET_CANARY}`],
    }));
    await flush();
    await s.advance(1_375);
    gate.resolve(completed());
    await holder;
    const receipt = await pending;
    // Hand-derived: 63 seconds at $0.036/hour = $0.000630.
    const expected = {
      commandId: "accounted", seconds: 63, dollars: 0.00063, queueWaitMs: 1_375,
      warm: "warm", sandboxId: s.starts[0]!.sandboxId,
    };
    expect.soft(receipt).toMatchObject({ status: "completed", exitCode: 0, ...expected });
    const usage = s.executor.getUsage().filter((row) => row.commandId === "accounted");
    expect(usage).toHaveLength(1);
    expect.soft(usage[0]).toMatchObject({ ...expected, exitCode: 0, runId: "run-9", cardId: "card-9", repoId: "repo-1" });
    const costRows = s.logs.filter((entry) => entry.level === "info" && entry.message.includes("expected-cost"))
      .map(expectedCostPayload).filter((payload) => payload.commandId === "accounted");
    expect.soft(costRows).toHaveLength(1);
    expect.soft(costRows[0]).toMatchObject(expected);
    expect(JSON.stringify(s.logs)).not.toContain(SECRET_CANARY);
  });
});
