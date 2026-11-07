import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolVm } from "./offload-pool.js";
import { command, DiskState, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => {
  s = await fixture();
  s.boat.limitsResponse.machineTypes = ["small", "default", "large"].map((type) => ({ type, available: true, reason: null }));
});
afterEach(async () => { await s.dispose(); });

async function savedPool() {
  return Object.entries(await s.state.all())
    .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")![1] as {
      vms: Array<Omit<PoolVm, "idleHandle">>;
    };
}

async function restart(stopped: boolean) {
  if (stopped) await s.clock.advance(15_000);
  s.clock.crashWorker();
}

it("retires a keyless recovered VM after reconciling its unresolved receipt", async () => {
  s.boat.stopMode = "stays_up";
  s.fail.add("exec:legacy");
  const first = command("legacy");
  const original = s.make({ size: "default" });
  expect(await s.execute(first, original)).toMatchObject({ status: "unknown", fallbackSafe: false });
  const old = s.starts[0]!.sandboxId;
  s.clock.crashWorker();
  s.fail.clear();
  const [encoded, raw] = Object.entries(await s.state.all())
    .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
  const doc = raw as Awaited<ReturnType<typeof savedPool>>;
  delete doc.vms[0]!.compatibilityKey;
  await s.state.set(JSON.parse(encoded) as Parameters<typeof s.state.set>[0], doc);

  const recovered = s.make({ size: "large" }, new DiskState(s.state.path));
  await recovered.recover();
  expect((await savedPool()).vms[0]).toMatchObject({ sandboxId: old, quarantined: true });
  expect((await savedPool()).vms[0]!.compatibilityKey).toBeUndefined();
  expect(s.boat.callsOf("create")).toHaveLength(1);
  expect(s.boat.callsOf("resume")).toHaveLength(0);

  s.boat.boxes.get(old)!.state = "archived";
  await recovered.sweep();
  expect((await savedPool()).vms[0]).toMatchObject({ sandboxId: old, quarantined: false, stopped: true });
  expect((await savedPool()).vms[0]!.compatibilityKey).toBeUndefined();
  expect(await s.execute(first, recovered)).toMatchObject({ status: "unknown", fallbackSafe: false });
  expect(s.starts).toHaveLength(1);
  expect(await s.execute(command("replacement"), recovered)).toMatchObject({ status: "completed", warm: "cold" });
  expect(s.starts[1]!.sandboxId).not.toBe(old);
  expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toContain(old);
  expect(s.boat.callsOf("resume")).toHaveLength(0);
  expect(s.boat.callsOf("create")[1]!.args.type).toBe("large");
});

describe.each([false, true])("offload pool size compatibility (stopped=%s)", (stopped) => {
  it.each([
    ["default", "large"], ["large", "default"], ["large", "small"],
  ] as const)("retires a %s VM rather than claiming it under %s config", async (before, after) => {
    const original = s.make({ size: before });
    expect(await s.execute(command("first"), original)).toMatchObject({ status: "completed" });
    const old = s.starts[0]!.sandboxId;
    expect(s.boat.callsOf("create")[0]!.args.type).toBe(before);
    await restart(stopped);

    const recovered = s.make({ size: after }, new DiskState(s.state.path));
    expect(await s.execute(command("replacement"), recovered)).toMatchObject({ status: "completed", warm: "cold" });
    const replacement = s.starts[1]!.sandboxId;
    expect(replacement).not.toBe(old);
    expect(s.boat.boxes.has(old)).toBe(false);
    expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toContain(old);
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("create")[1]!.args.type).toBe(after);
    expect((await savedPool()).vms.map((vm) => vm.sandboxId)).toEqual([replacement]);
  });

  it.each([undefined, "delegated-template"])("reuses the legacy default-size key with template %s", async (templateSnapshot) => {
    const original = s.make({ templateSnapshot });
    const first = command("legacy");
    expect(await s.execute(first, original)).toMatchObject({ status: "completed" });
    const old = s.starts[0]!.sandboxId;
    const legacyKey = [first.companyId, first.repoId, first.profileId, first.trustDomainId];
    if (templateSnapshot) legacyKey.push(templateSnapshot);
    // Pin the pre-size key layout, not a key derived by the implementation.
    expect((await savedPool()).vms[0]!.compatibilityKey).toBe(JSON.stringify(legacyKey));
    await restart(stopped);

    const recovered = s.make({ size: "default", templateSnapshot }, new DiskState(s.state.path));
    expect(await s.execute(command("reuse-default"), recovered)).toMatchObject({ status: "completed", sandboxId: old });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(0);
  });

  it("reuses a large VM when the configured size is unchanged", async () => {
    const original = s.make({ size: "large" });
    const first = command("large");
    expect(await s.execute(first, original)).toMatchObject({ status: "completed" });
    const old = s.starts[0]!.sandboxId;
    expect((await savedPool()).vms[0]!.compatibilityKey).toBe(JSON.stringify([
      first.companyId, first.repoId, first.profileId, first.trustDomainId, ["size", "large"],
    ]));
    await restart(stopped);

    const recovered = s.make({ size: "large" }, new DiskState(s.state.path));
    expect(await s.execute(command("reuse-large"), recovered)).toMatchObject({ status: "completed", sandboxId: old });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(0);
  });
});
