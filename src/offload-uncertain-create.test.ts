// B13: a pool create whose reply is lost must not bill a second VM. The retry
// reuses the same idempotency key: a compatible retry adopts the replayed VM,
// an incompatible one stops and deletes it before freeing the slot. Uses fakes only.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
import { OffloadPoolStore } from "./offload-pool.js";
import type { OffloadCommand, OffloadDeps } from "./offload.js";
import { FakeBoat, responseError, trialLimits } from "./test-support/fake-boat.js";
import { JsonState } from "./test-support/account-admission.fixture.js";

const EPOCH = Date.parse("2026-10-23T10:00:00Z");

function command(commandId: string, profileId = "rust-secret-free"): OffloadCommand {
  return {
    commandId,
    companyId: "company-1",
    runId: "run-1",
    cardId: "card-1",
    repoId: "repo-1",
    profileId,
    argv: ["test", "--locked"],
  };
}

let nextAccount = 0;

function setup(runCommand: OffloadDeps["runCommand"] = async () => ({ exitCode: 0, seconds: 1 }),
  config: Record<string, unknown> = {}) {
  const account = { state: new JsonState(), accountId: `uncertain-create-account-${++nextAccount}`, poolId: "uncertain-create" };
  const clock = { t: EPOCH };
  const now = () => clock.t;
  const fake = new FakeBoat({ now });
  const timers = new Map<number, { at: number; cb: () => void }>();
  let serial = 0;
  // `durablePool` wires the pool store the harness otherwise omits, so a
  // second executor over the same state models a process restart.
  const open = (durablePool = false) => {
    const opened = new OffloadExecutor({
      ...account,
      boat: fake as unknown as BoatApiLike,
      logger: { info() {}, warn() {}, error() {} },
      now,
      timers: { set: (cb: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: clock.t + ms, cb }); return id; },
        clear: (handle: unknown) => { timers.delete(handle as number); } },
      config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0, ...config },
      runCommand,
    });
    if (durablePool) (opened as unknown as { poolStore: OffloadPoolStore }).poolStore =
      new OffloadPoolStore(account.state, account.accountId, account.poolId);
    return opened;
  };
  const executor = open();
  return { executor, fake, account, clock, open };
}

function ledgerDoc(s: ReturnType<typeof setup>) {
  const key = JSON.stringify(["instance", null, "boat-account",
    createHash("sha256").update(s.account.accountId).digest("hex")]);
  return JSON.parse(s.account.state.rows.get(key)!) as {
    intents: Array<{ id: string; status: string; operation: string; ttlSeconds: number; sandboxId: string | null }>;
  };
}

describe("offload uncertain create", () => {
  it("a compatible retry replays the same key and adopts the VM", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.boxes.size).toBe(1);

    const second = await s.executor.execute(command("cmd-2"));
    expect(second).toMatchObject({ status: "completed", warm: "cold" });

    // One retry, same key, no second VM: the lost reply's box runs the command.
    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(2);
    const key = creates[0]!.args.idempotencyKey;
    expect(typeof key).toBe("string");
    expect(creates[1]!.args.idempotencyKey).toBe(key);
    expect(s.fake.boxes.size).toBe(1);
    const [id] = [...s.fake.boxes.keys()];
    expect(second).toMatchObject({ sandboxId: id });
    expect(s.fake.callsOf("stop")).toHaveLength(0);
  });

  it.each([
    { nextStartDollars: 0.01 },
    { planIncluded: undefined },
    { planIncluded: { vmHours: 25, vmHoursRemaining: 0, periodEnd: new Date(EPOCH + 86_400_000) } },
    { planIncluded: { vmHours: 25, vmHoursRemaining: 25, periodEnd: new Date(EPOCH) } },
  ])("never replays a request lost before the provider when current included admission refuses: %j", async (overrides) => {
    const s = setup();
    s.fake.failNext("create", () => new Error("synthetic request lost before provider effect"));
    expect(await s.executor.execute(command("cmd-lost"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(0);
    const original = ledgerDoc(s).intents[0]!.id;
    s.fake.limitsResponse = trialLimits(overrides);
    expect(await s.executor.execute(command("cmd-refused"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.boxes.size).toBe(0);
    expect(ledgerDoc(s).intents[0]!.id).toBe(original);
    expect(ledgerDoc(s).intents[0]!.status).toBe("ambiguous");
    s.fake.limitsResponse = trialLimits();
    expect(await s.executor.execute(command("cmd-recovered"))).toMatchObject({ status: "completed" });
    expect(s.fake.callsOf("create")[1]!.args.idempotencyKey).toBe(s.fake.callsOf("create")[0]!.args.idempotencyKey);
    expect(s.fake.boxes.size).toBe(1);
  });

  it("retains renewed replay funding when the replay itself loses its reply", async () => {
    const s = setup();
    s.fake.failNext("create", () => new Error("synthetic request lost before provider effect"));
    await s.executor.execute(command("cmd-lost"));
    s.clock.t += 120_000;
    s.fake.failNext("create", () => new Error("synthetic replay reply lost"));
    expect(await s.executor.execute(command("cmd-retry"))).toMatchObject({ status: "unavailable" });
    // Original timeout 120 + preparation 90 + tail 15, plus elapsed 120.
    expect(ledgerDoc(s).intents[0]!.ttlSeconds).toBe(345);
    expect(ledgerDoc(s).intents[0]!.status).toBe("ambiguous");
    expect(s.fake.callsOf("create")[1]!.args).toEqual(s.fake.callsOf("create")[0]!.args);
  });

  it("an incompatible retry deletes the replayed VM before creating a replacement", async () => {
    // One VM of account capacity: settle the retained hold, but do not free
    // pool ownership while the stopped disk still exists.
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });
    const [oldId] = [...s.fake.boxes.keys()];

    const second = await s.executor.execute(command("cmd-2", "other-profile"));
    expect(second).toMatchObject({ status: "completed" });

    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(3);
    expect(creates[1]!.args.idempotencyKey).toBe(creates[0]!.args.idempotencyKey);
    expect(creates[2]!.args.idempotencyKey).not.toBe(creates[0]!.args.idempotencyKey);
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([oldId]);
    expect(s.fake.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([oldId]);
    expect(s.fake.calls.indexOf(s.fake.callsOf("deleteSandbox")[0]!)).toBeLessThan(s.fake.calls.indexOf(creates[2]!));
    expect(s.fake.boxes.has(oldId!)).toBe(false);
    expect(s.fake.boxes.size).toBe(1);
    expect(second).toMatchObject({ sandboxId: [...s.fake.boxes.keys()][0] });
  });

  it.each([false, true])("retains failed incompatible replay deletion for shutdown retry (restart=%s)", async (restart) => {
    const s = setup(undefined, { maxActive: 1 });
    const first = s.open(true);
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await first.execute(command("cmd-lost"))).toMatchObject({ status: "unavailable" });
    const [oldId] = [...s.fake.boxes.keys()];
    s.fake.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    expect(await first.execute(command("cmd-incompatible", "other-profile"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.get(oldId!)?.state).toBe("archived");
    expect(await new OffloadPoolStore(s.account.state, s.account.accountId, s.account.poolId).load()).toMatchObject([
      { sandboxId: oldId, deletePending: true, quarantined: true },
    ]);
    expect(s.fake.callsOf("create")).toHaveLength(2); // same-key replay only, no replacement

    const executor = restart ? s.open(true) : first;
    // Neither a compatible nor an incompatible caller may reuse the pending disk.
    expect(await executor.execute(command("cmd-pending"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("resume")).toHaveLength(0);
    expect(s.fake.callsOf("create")).toHaveLength(2);
    await executor.shutdown();
    expect(s.fake.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([oldId, oldId]);
    expect(s.fake.boxes.has(oldId!)).toBe(false);
    expect(await new OffloadPoolStore(s.account.state, s.account.accountId, s.account.poolId).load()).toEqual([]);

    const after = s.open(true);
    expect(await after.execute(command("cmd-after", "other-profile"))).toMatchObject({ status: "completed" });
    expect(s.fake.callsOf("create")).toHaveLength(3);
    expect(s.fake.boxes.size).toBe(1);
    await after.shutdown();
  });

  it("accepts provider 404 as confirmed deletion of an incompatible replay", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    await s.executor.execute(command("cmd-lost"));
    const [oldId] = [...s.fake.boxes.keys()];
    s.fake.failNext("deleteSandbox", () => {
      s.fake.boxes.delete(oldId!);
      return responseError(404, { code: "not_found" });
    });
    expect(await s.executor.execute(command("cmd-after", "other-profile"))).toMatchObject({ status: "completed" });
    expect(s.fake.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([oldId]);
    expect(s.fake.boxes.has(oldId!)).toBe(false);
    expect(s.fake.boxes.size).toBe(1);
  });

  it("replays the exact original body, not the new command's timeout or config", async () => {
    const s = setup(undefined, { monitoring: false });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute({ ...command("cmd-1"), timeoutMs: 600_000 })).toMatchObject({ status: "unavailable" });

    // A shorter retry must not shrink the replayed TTL or flip monitoring:
    // same key + same body, or the provider must refuse the mismatch.
    const second = await s.executor.execute({ ...command("cmd-2"), timeoutMs: 120_000 });
    expect(second).toMatchObject({ status: "completed" });
    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(2);
    expect(creates[1]!.args).toEqual(creates[0]!.args);
    expect(creates[1]!.args).toMatchObject({ monitoring: false, ttlSeconds: creates[0]!.args.ttlSeconds });
    expect(s.fake.boxes.size).toBe(1);
  });

  it("keeps the placeholder quarantined when the replay is rejected without proof", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    // A body-mismatch refusal proves nothing about the lost VM: no retire, no
    // second VM, and the next claim retries the same key.
    s.fake.failNext("create", () => responseError(422, { code: "idempotency_key_mismatch" }));
    expect(await s.executor.execute(command("cmd-2"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(2);

    const third = await s.executor.execute(command("cmd-3"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
  });

  it("reserves an adopted replay so a second command cannot run on it concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const s = setup(async () => { runs += 1; await gate; return { exitCode: 0, seconds: 1 }; }, { queueLimit: 0 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    const running = s.executor.execute(command("cmd-2"));
    await vi.waitFor(() => expect(runs).toBe(1));
    // The adopted VM is busy: the next command from the workspace waits
    // instead of running concurrently on it.
    let thirdSettled: unknown = "pending";
    void s.executor.execute(command("cmd-3")).then((result) => { thirdSettled = result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(thirdSettled).toMatchObject({ status: "unavailable" });
    expect(runs).toBe(1);
    release();
    expect(await running).toMatchObject({ status: "completed" });
  });

  it("leaves the placeholder untouched when the replay receipt write fails", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    const innerSet = s.account.state.set.bind(s.account.state);
    s.account.state.set = (async (key: never, value: unknown) => {
      if (JSON.stringify(value).includes('"status":"running"')) throw new Error("synthetic receipt failure");
      return innerSet(key as never, value as never);
    }) as typeof innerSet;
    expect(await s.executor.execute(command("cmd-2"))).toMatchObject({ status: "unavailable" });
    s.account.state.set = innerSet;

    // The failed receipt failed the new hold instead of stranding it.
    expect(s.executor.getUsage().filter((row) => row.commandId === "cmd-2").map((row) => row.kind))
      .toEqual(["failed_start"]);

    // Nothing was recorded: one box, and the next claim replays the same key
    // (a create) instead of warm-updating a half-adopted VM.
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(2);
    const third = await s.executor.execute(command("cmd-3"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(3);
    expect(s.fake.callsOf("create")[2]!.args.idempotencyKey).toBe(s.fake.callsOf("create")[0]!.args.idempotencyKey);
    expect(s.fake.callsOf("update")).toHaveLength(0);
  });

  it("funds the adopting command, not the lost one", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });
    expect(await s.executor.execute(command("cmd-2"))).toMatchObject({ status: "completed" });

    const rows = s.executor.getUsage();
    const dispatched = rows.filter((row) => row.kind === "command");
    expect(dispatched.map((row) => row.commandId)).toEqual(["cmd-2"]);
    expect(rows.filter((row) => row.kind === "failed_start").map((row) => row.commandId)).toEqual(["cmd-1"]);
  });

  it("retains uncertainty when current capacity cannot fund a possible first-effect replay", async () => {
    // A same-key POST might be the first request that reaches the provider.
    // Without read-only key lookup, a full account cannot safely replay it.
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    s.fake.limitsResponse = trialLimits({ activeSandboxes: 1 });
    const second = await s.executor.execute(command("cmd-2"));
    const [id] = [...s.fake.boxes.keys()];
    expect(second).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.has(id!)).toBe(true);
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.callsOf("stop")).toHaveLength(0);
  });

  it("extends the provider TTL when the adopter funds a longer envelope", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute({ ...command("cmd-1"), timeoutMs: 60_000 })).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("create")[0]!.args.ttlSeconds).toBe(165);

    const second = await s.executor.execute({ ...command("cmd-2"), timeoutMs: 600_000 });
    expect(second).toMatchObject({ status: "completed" });

    // Same key, same original body on replay; the TTL extension is an update.
    const creates = s.fake.callsOf("create");
    expect(creates[1]!.args).toEqual(creates[0]!.args);
    const [id] = [...s.fake.boxes.keys()];
    expect(s.fake.callsOf("update")).toHaveLength(1);
    expect(s.fake.callsOf("update")[0]!.args).toMatchObject({ sandboxId: id, ttlSeconds: 705 });
    expect(s.fake.boxes.get(id!)?.ttlSeconds).toBe(705);
    expect(second).toMatchObject({ sandboxId: id });
  });

  it("fails the adopter hold when the adoption pool write fails", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    // Fail the pool write that must durably record the adoption (the adopter
    // receipt itself succeeds first). The harness wires no pool store, so the
    // failure is injected at the persist seam.
    const persist = s.executor as unknown as { persistPool: () => Promise<void> };
    const innerPersist = persist.persistPool.bind(s.executor);
    persist.persistPool = async () => { throw new Error("synthetic pool failure"); };
    expect(await s.executor.execute(command("cmd-2"))).toMatchObject({ status: "unavailable" });
    persist.persistPool = innerPersist;

    // The adopter hold was failed, not stranded: cmd-2 never ran, and the
    // next claim replays the same key onto the same VM.
    expect(s.executor.getUsage().filter((row) => row.commandId === "cmd-2").map((row) => row.kind))
      .toEqual(["failed_start"]);
    const third = await s.executor.execute(command("cmd-3"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
    const creates = s.fake.callsOf("create");
    expect(creates[2]!.args.idempotencyKey).toBe(creates[0]!.args.idempotencyKey);
    expect(third).toMatchObject({ sandboxId: [...s.fake.boxes.keys()][0] });
  });

  it("keeps the original hold and adds no stray holds when adoption is refused", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    // Refuse the adopter (machine type unavailable): the live VM keeps its
    // original hold, and no adopter hold is left behind.
    s.fake.limitsResponse = trialLimits({ machineTypes: [{ type: "default", available: false, reason: "test" }] });
    expect(await s.executor.execute(command("cmd-2"))).toMatchObject({ status: "unavailable" });
    const rows = s.executor.getUsage();
    expect(rows.filter((row) => row.commandId === "cmd-1").map((row) => row.kind)).toEqual(["aborted_start"]);
    expect(rows.filter((row) => row.commandId === "cmd-2")).toHaveLength(0);

    // Capacity restored: the next claim adopts the same VM.
    s.fake.limitsResponse = trialLimits();
    const third = await s.executor.execute(command("cmd-3"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
    expect(third).toMatchObject({ sandboxId: [...s.fake.boxes.keys()][0] });
  });

  it("extends the provider TTL when the replay is delayed even for a shorter adopter", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute({ ...command("cmd-1"), timeoutMs: 600_000 })).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("create")[0]!.args.ttlSeconds).toBe(705);

    // 600 s of the 705 s TTL elapsed before the next claim. The shorter
    // adopter (225 s envelope) would otherwise lose its VM ~105 s into the
    // run, so the adoption must renew the deadline from now.
    s.clock.t += 600_000;
    const second = await s.executor.execute(command("cmd-2"));
    expect(second).toMatchObject({ status: "completed" });

    const [id] = [...s.fake.boxes.keys()];
    const updates = s.fake.callsOf("update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args).toMatchObject({ sandboxId: id, ttlSeconds: 225 });
    expect(s.fake.boxes.get(id!)?.ttlSeconds).toBe(225);
    expect(second).toMatchObject({ sandboxId: id });
  });

  it("keeps the placeholder quarantined when the adoption TTL extension is refused", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute({ ...command("cmd-1"), timeoutMs: 60_000 })).toMatchObject({ status: "unavailable" });

    // The longer adopter needs a TTL extension, but the provider refuses: fail
    // closed without dispatching, and keep the VM tracked for the next replay.
    s.fake.failNext("update", () => responseError(500, { code: "internal" }));
    expect(await s.executor.execute({ ...command("cmd-2"), timeoutMs: 600_000 })).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.executor.getUsage().filter((row) => row.commandId === "cmd-2").map((row) => row.kind))
      .toEqual(["failed_start"]);

    const third = await s.executor.execute({ ...command("cmd-3"), timeoutMs: 600_000 });
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("update")).toHaveLength(2);
  });

  it("renews the original hold through the extended deadline when the adopter receipt fails", async () => {
    const s = setup();
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute({ ...command("cmd-1"), timeoutMs: 60_000 })).toMatchObject({ status: "unavailable" });

    const innerSet = s.account.state.set.bind(s.account.state);
    s.account.state.set = (async (key: never, value: unknown) => {
      if (JSON.stringify(value).includes('"status":"running"')) throw new Error("synthetic receipt failure");
      return innerSet(key as never, value as never);
    }) as typeof innerSet;
    expect(await s.executor.execute({ ...command("cmd-2"), timeoutMs: 600_000 })).toMatchObject({ status: "unavailable" });
    s.account.state.set = innerSet;

    // The extension landed (provider deadline now 705 s) and the adopter hold
    // failed; the original hold was renewed through the extended deadline.
    expect(s.fake.callsOf("update")).toHaveLength(1);
    expect(s.executor.getUsage().filter((row) => row.commandId === "cmd-2").map((row) => row.kind))
      .toEqual(["failed_start"]);
    const original = ledgerDoc(s).intents.find((i) => i.operation === "create");
    expect(original?.status).not.toBe("rejected");
    expect(original?.ttlSeconds).toBe(705);

    // Past the original 165 s TTL plus the stale-hold margin, the renewed hold
    // still covers the VM: the next claim adopts it instead of leaking it.
    s.clock.t += 700_000;
    const third = await s.executor.execute({ ...command("cmd-3"), timeoutMs: 600_000 });
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.boxes.size).toBe(1);
  });

  it("keeps an incompatible replay tracked when its stop is unconfirmed", async () => {
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    // A failed replay stop retains deletion ownership, not a reusable cache.
    s.fake.failNext("stop", () => responseError(500, { code: "internal" }));
    expect(await s.executor.execute(command("cmd-2", "other-profile"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(2);
    expect(s.fake.callsOf("stop")).toHaveLength(1);
    expect(await s.executor.execute(command("cmd-compatible"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.callsOf("resume")).toHaveLength(0);

    // Sweep owns the pending delete even when the stop reply was lost. Only
    // confirmed deletion frees the slot for a command on a fresh VM.
    await s.executor.sweep();
    expect(s.fake.callsOf("deleteSandbox")).toHaveLength(1);
    const third = await s.executor.execute(command("cmd-3", "other-profile"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.callsOf("stop")).toHaveLength(1);
    expect(s.fake.boxes.size).toBe(1);
    expect(third).toMatchObject({ sandboxId: [...s.fake.boxes.keys()][0] });
  });

  // F3: an empty-ID placeholder whose intent is durably settled (stale TTL
  // expiry or an explicit rejection) must retire and free the pool without
  // any same-key replay, in process and across a restart.
  type Internals = { pool: Array<{ sandboxId: string; accountReservation?: unknown }>; ledger: {
    failed(r: unknown, definitive: boolean): Promise<void>; started(api: unknown, r: unknown, id: string): Promise<number> } };
  const internals = (executor: OffloadExecutor) => executor as unknown as Internals;

  it.each([false, true])("retires a request lost before the provider once its hold is stale, without replay (restart=%s)", async (restart) => {
    const s = setup();
    const first = s.open(true);
    s.fake.failNext("create", () => new Error("synthetic request lost before provider effect"));
    expect(await first.execute(command("cmd-lost"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(0);
    const lostKey = s.fake.callsOf("create")[0]!.args.idempotencyKey;
    // Past the funded TTL (225 s) plus the 10 minute stale-hold margin.
    s.clock.t += 225_000 + 10 * 60_000 + 60_000;
    const executor = restart ? s.open(true) : first;

    expect(await executor.execute(command("cmd-after"))).toMatchObject({ status: "completed" });
    const creates = s.fake.callsOf("create");
    // Exactly one more create, and it is a fresh allocation, not a replay.
    expect(creates).toHaveLength(2);
    expect(creates[1]!.args.idempotencyKey).not.toBe(lostKey);
    expect(s.fake.boxes.size).toBe(1);
    expect(internals(executor).pool.filter((vm) => vm.sandboxId === "")).toHaveLength(0);
    expect(ledgerDoc(s).intents.find((i) => i.operation === "create")?.status).toBe("stopped");
  });

  it.each([false, true])("retires a placeholder whose intent was durably rejected, without replay (restart=%s)", async (restart) => {
    const s = setup();
    const first = s.open(true);
    s.fake.failNext("create", () => new Error("synthetic request lost before provider effect"));
    expect(await first.execute(command("cmd-lost"))).toMatchObject({ status: "unavailable" });
    const [placeholder] = internals(first).pool;
    // The definitive rejection landed in the ledger but the retire never persisted.
    await internals(first).ledger.failed(placeholder!.accountReservation, true);
    expect(ledgerDoc(s).intents[0]!.status).toBe("rejected");
    const executor = restart ? s.open(true) : first;

    expect(await executor.execute(command("cmd-after"))).toMatchObject({ status: "completed" });
    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(2);
    expect(creates[1]!.args.idempotencyKey).not.toBe(creates[0]!.args.idempotencyKey);
    expect(s.fake.boxes.size).toBe(1);
    expect(internals(executor).pool.filter((vm) => vm.sandboxId === "")).toHaveLength(0);
  });

  it.each([false, true])("recovers the sandbox of a running receipt saved before the pool identity, without a same-key POST (restart=%s)", async (restart) => {
    const s = setup();
    const first = s.open(true);
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await first.execute(command("cmd-lost"))).toMatchObject({ status: "unavailable" });
    const [id] = [...s.fake.boxes.keys()];
    const [placeholder] = internals(first).pool;
    // The running receipt is durable; the pool still holds the empty identity.
    await internals(first).ledger.started(s.fake, placeholder!.accountReservation, id!);
    expect(ledgerDoc(s).intents.find((i) => i.operation === "create")).toMatchObject({ status: "running", sandboxId: id });
    const executor = restart ? s.open(true) : first;

    const second = await executor.execute(command("cmd-2"));
    expect(second).toMatchObject({ status: "completed", sandboxId: id });
    expect(s.fake.callsOf("create")).toHaveLength(1);
    expect(s.fake.boxes.size).toBe(1);
    expect(internals(executor).pool.filter((vm) => vm.sandboxId === "")).toHaveLength(0);
  });
});
