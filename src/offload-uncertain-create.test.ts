// B13: a pool create whose reply is lost must not bill a second VM. The retry
// reuses the same idempotency key: a compatible retry adopts the replayed VM,
// an incompatible one stops it and frees the slot. Uses fakes only.
import { describe, expect, it } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
import type { OffloadCommand, OffloadDeps } from "./offload.js";
import { FakeBoat } from "./test-support/fake-boat.js";
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
  return { executor, fake };
}

describe("offload uncertain create", () => {
  it("a compatible retry replays the same key and adopts the VM", async () => {
    const s = setup();
    // The provider effect lands; only the reply is lost.
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    const first = await s.executor.execute(command("cmd-1"));
    expect(first).toMatchObject({ status: "unavailable" });
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
    // fresh create can be admitted, or the slot leaks quarantined forever.
    const s = setup(undefined, { maxActive: 1 });
    s.fake.failNext("create", (args) => s.fake.loseCreateReply(args));
    const first = await s.executor.execute(command("cmd-1"));
    expect(first).toMatchObject({ status: "unavailable" });

    // Another trust domain must not adopt the replayed VM.
    const second = await s.executor.execute(command("cmd-2", "other-profile"));
    expect(second).toMatchObject({ status: "completed" });

    const creates = s.fake.callsOf("create");
    expect(creates).toHaveLength(3);
    // The retry replays the lost create under the same key...
    expect(creates[1]!.args.idempotencyKey).toBe(creates[0]!.args.idempotencyKey);
    // ...then the freed slot creates fresh under a new key.
    expect(creates[2]!.args.idempotencyKey).not.toBe(creates[0]!.args.idempotencyKey);

    // The replayed VM was stopped exactly once and never adopted: two boxes,
    // one archived, the other running the command.
    const ids = [...s.fake.boxes.keys()];
    expect(ids).toHaveLength(2);
    const stoppedId = ids.find((id) => s.fake.boxes.get(id)?.state === "archived")!;
    expect(s.fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([stoppedId]);
    expect(second).toMatchObject({ sandboxId: ids.find((id) => id !== stoppedId) });
  });
});
