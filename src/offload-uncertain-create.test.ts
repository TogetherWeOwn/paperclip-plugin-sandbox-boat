// B13: a pool create whose reply is lost must not bill a second VM. The retry
// reuses the same idempotency key: a compatible retry adopts the replayed VM,
// an incompatible one stops it and frees the slot. Uses fakes only.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
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
  const executor = new OffloadExecutor({
    ...account,
    boat: fake as unknown as BoatApiLike,
    logger: { info() {}, warn() {}, error() {} },
    now,
    timers: { set: (cb: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: clock.t + ms, cb }); return id; },
      clear: (handle: unknown) => { timers.delete(handle as number); } },
    config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0, ...config },
    runCommand,
  });
  return { executor, fake, account, clock };
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

  it("an incompatible retry stops the replayed VM and frees the slot", async () => {
    // One VM of account capacity: the retained hold must be released before a
    // fresh create is admitted, or the slot leaks quarantined forever.
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    const second = await s.executor.execute(command("cmd-2", "other-profile"));
    expect(second).toMatchObject({ status: "completed" });

    // The retry replays the lost create under the same key, then the freed
    // slot creates fresh under a new key.
    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(3);
    expect(creates[1]!.args.idempotencyKey).toBe(creates[0]!.args.idempotencyKey);
    expect(creates[2]!.args.idempotencyKey).not.toBe(creates[0]!.args.idempotencyKey);

    // The replayed VM was stopped exactly once and never adopted: two boxes,
    // one archived, the other running the command.
    const ids = [...s.fake.boxes.keys()];
    expect(ids).toHaveLength(2);
    const stoppedId = ids.find((id) => s.fake.boxes.get(id)?.state === "archived")!;
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([stoppedId]);
    expect(second).toMatchObject({ sandboxId: ids.find((id) => id !== stoppedId) });
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

  it("adopts a compatible replay without charging a second active slot at maxActive=1", async () => {
    // The lost VM already occupies the single provider slot. Adoption reuses
    // it warm, so no second create slot is admitted.
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    expect(await s.executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });

    s.fake.limitsResponse = trialLimits({ activeSandboxes: 1 });
    const second = await s.executor.execute(command("cmd-2"));
    const [id] = [...s.fake.boxes.keys()];
    expect(second).toMatchObject({ status: "completed", warm: "cold", sandboxId: id });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(2);
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

    // Both the replay stop and the synchronous retirement retry fail: the
    // command stays local, but the VM is tracked, not retired.
    s.fake.failNext("stop", () => responseError(500, { code: "internal" }));
    s.fake.failNext("stop", () => responseError(500, { code: "internal" }));
    expect(await s.executor.execute(command("cmd-2", "other-profile"))).toMatchObject({ status: "unavailable" });
    expect(s.fake.boxes.size).toBe(1);
    expect(s.fake.callsOf("create")).toHaveLength(2);
    expect(s.fake.callsOf("stop")).toHaveLength(2);

    // The next incompatible command retries the pending stop, frees the slot,
    // and runs on a fresh VM: the lost box is deleted, exactly one new box runs.
    const third = await s.executor.execute(command("cmd-3", "other-profile"));
    expect(third).toMatchObject({ status: "completed" });
    expect(s.fake.callsOf("stop")).toHaveLength(3);
    expect(s.fake.boxes.size).toBe(1);
    expect(third).toMatchObject({ sandboxId: [...s.fake.boxes.keys()][0] });
  });
});
