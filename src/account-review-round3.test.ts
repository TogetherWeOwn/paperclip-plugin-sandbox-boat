import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { parseDriverConfig } from "./config.js";
import { COMPANY, EPOCH, advance, fixture, limits } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

function journal() {
  const entry = f.state.snapshot().find(([key]) => key.includes("boat-account"));
  expect(entry).toBeDefined();
  return JSON.parse(entry![1]) as { intents: Array<{ sandboxId: string; status: string; active: boolean; compute: number; activeReflected: boolean; computeReflected: number }> };
}

async function twoAccounts() {
  const other = new FakeBoat({ now: () => Date.now() });
  other.limitsResponse = limits();
  // Real provider identities are globally unique. Give the independent fake's
  // counter a different prefix of history, not a shared inventory.
  await other.create(); other.boxes.clear(); other.calls.length = 0;
  setBoatApiFactoryForTests((options) => (options.apiKey === "synthetic-key-b" ? other : f.boat) as unknown as BoatApiLike);
  const manager = f.manager();
  const acquire = (suffix: string) => manager.acquire({
    driverKey: "boat", companyId: COMPANY, agentId: "synthetic-principal",
    environmentId: `env-${suffix}`, issueId: `issue-${suffix}`, executionWorkspaceId: `workspace-${suffix}`, runId: `run-${suffix}`,
    config: { apiKey: `synthetic-key-${suffix}`, cliproxyTunnel: false },
  } as never);
  const a = (await acquire("a")).providerLeaseId!;
  const b = (await acquire("b")).providerLeaseId!;
  expect(a).not.toBe(b);
  return { other, manager, a, b };
}

describe("credential-bound reconciliation", () => {
  it.each([false, true])("never retires another account's live hold (first inventory fails: %s)", async (failFirst) => {
    const { other, manager, a, b } = await twoAccounts();
    if (failFirst) f.boat.failNext("sandboxes", new Error("synthetic inventory outage"));
    await manager.sweep("credential-partitions", { force: true });
    expect(f.boat.boxes.get(a)?.state).toBe("ready");
    expect(other.boxes.get(b)?.state).toBe("ready");
    for (const id of [a, b]) {
      const intents = journal().intents.filter((i) => i.sandboxId === id);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ status: "running", active: true });
      expect(intents[0]!.compute).toBeGreaterThan(0);
    }
    expect(f.boat.callsOf("get").filter((call) => call.args.sandboxId === b)).toEqual([]);
    expect(other.callsOf("get").filter((call) => call.args.sandboxId === a)).toEqual([]);
  });

  it("retains a legacy unbound hold when the only available credential returns a foreign 404", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const other = new FakeBoat({ now: () => Date.now() });
    const reservation = await ledger.reserve(other as unknown as BoatApiLike, { operation: "create", size: "default",
      jobSeconds: 60, tailSeconds: 0, maxActive: 2, maxStartsPerDay: 70, minComputeHoursLeft: 0 });
    other.addSandbox({ id: "legacy-foreign-vm", state: "ready" });
    await ledger.started(other as unknown as BoatApiLike, reservation, "legacy-foreign-vm");
    const manager = f.manager();
    manager.rememberConfig(COMPANY, "sole-available-environment", parseDriverConfig({ apiKey: "synthetic-key-a", cliproxyTunnel: false }));
    await manager.sweep("legacy-unknown-owner", { force: true });
    expect(journal().intents[0]).toMatchObject({ status: "running", active: true, compute: 60 });
    expect(other.boxes.get("legacy-foreign-vm")!.state).toBe("ready");
  });

  it("keeps persisted ownership when a reconstructed manager discovers groups in reverse order", async () => {
    const { other, a, b } = await twoAccounts();
    const recovered = f.manager();
    for (const suffix of ["b", "a"]) recovered.rememberConfig(COMPANY, `env-${suffix}`,
      parseDriverConfig({ apiKey: `synthetic-key-${suffix}`, cliproxyTunnel: false }));
    f.boat.boxes.get(a)!.state = "archived";
    await recovered.sweep("reconstructed-partitions", { force: true });
    expect(journal().intents.find((i) => i.sandboxId === a)).toMatchObject({ status: "stopped", active: false });
    expect(journal().intents.find((i) => i.sandboxId === b)).toMatchObject({ status: "running", active: true });
    expect(other.callsOf("get").filter((call) => call.args.sandboxId === a)).toEqual([]);
  });

  it("does not reflect one account's counters against the other account's hold", async () => {
    const { other, manager, b } = await twoAccounts();
    await advance(6_000);
    f.boat.limitsResponse = limits({ activeSandboxes: 1, creditUsedSeconds: 6 });
    // Different keys may alias the same provider account. Identical cumulative
    // deltas must never refund two separate holds for the same six paid seconds.
    other.limitsResponse = limits({ activeSandboxes: 1, creditUsedSeconds: 6 });
    await manager.sweep("credential-counters", { force: true });
    expect(other.boxes.get(b)?.state).toBe("ready");
    expect(journal().intents.find((i) => i.sandboxId === b)).toMatchObject({ active: true, activeReflected: false, computeReflected: 0 });
  });
});
