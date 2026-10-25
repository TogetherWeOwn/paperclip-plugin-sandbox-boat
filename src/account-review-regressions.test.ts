import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import type { BoatApiLike } from "./boat-client.js";
import { responseError } from "./test-support/fake-boat.js";
import {
  COMPANY, EPOCH, advance, command, fixture, limits, reconcile, starts, usage,
} from "./test-support/account-admission.fixture.js";

// Regression probes for the account-admission review findings. Each case
// failed (red) before its fix and passes after. The independently authored
// acceptance files are not modified; these probes use the same public seam.
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

function ledgerIntents(current: ReturnType<typeof fixture>) {
  const row = current.state.snapshot().find(([key]) => key.includes("boat-account"));
  expect(row, "account journal must be persisted").toBeDefined();
  return (JSON.parse(row![1]) as { intents: Array<Record<string, unknown>> }).intents;
}

function boatApi(current: ReturnType<typeof fixture>): BoatApiLike {
  return current.boat as unknown as BoatApiLike;
}

async function stoppedPool() {
  const p = f.pool();
  expect(await p.execute(command("seed"))).toMatchObject({ status: "completed" });
  await advance(15_000);
  expect(f.boat.callsOf("stop")).toHaveLength(1);
  return p;
}

describe("retry history uncertainty", () => {
  it("retains the hold when an ambiguous attempt precedes a refused retry", async () => {
    const manager = f.manager();
    f.boat.failNext("create", new Error("synthetic transport failure"));
    f.boat.failNext("create", responseError(429, { code: "rate_limited", message: "retry refused" }));
    await expect(f.acquire(manager, "uncertain-first")).rejects.toThrow();
    // The first attempt may have taken effect: the refusal of the retry must
    // not release the hold. A second start under maxActive 1 is refused
    // without dispatching.
    await expect(f.acquire(f.manager(), "uncertain-second", { maxActive: 1 })).rejects.toThrow();
    expect(f.boat.callsOf("create")).toHaveLength(2);
    const intents = ledgerIntents(f);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "ambiguous", active: true });
  });

  it("settles a no_ready_machine retry when the limits re-read fails", async () => {
    f.boat.failNext("create", responseError(503, { code: "no_ready_machine", message: "none ready" }));
    // The admission read succeeds; only the retry's re-read fails.
    const realLimits = f.boat.limits.bind(f.boat);
    let limitsCalls = 0;
    f.boat.limits = async (args) => {
      limitsCalls += 1;
      if (limitsCalls > 1) throw new Error("synthetic limits down");
      return realLimits(args);
    };
    await expect(f.acquire(f.manager(), "nomachine-limits-down")).rejects.toThrow();
    // A no_ready_machine-only history proves nothing started: the slot is
    // released instead of leaking as an unsettled, unreconciliable intent.
    const intents = ledgerIntents(f);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "rejected", active: false });
    f.boat.limits = realLimits;
    await expect(f.acquire(f.manager(), "after-settle")).resolves.toBeTruthy();
  });

  it("lets an unsettled start hold expire with its window", async () => {
    f.boat.limitsResponse = limits({ starts: starts(69) });
    f.boat.failNext("create", new Error("synthetic transport failure"));
    const p = f.pool();
    expect(await p.execute(command("unsettled-window"))).toMatchObject({ status: "unavailable" });
    // Day window: 69 used + this pending hold + 1 more fits 70; after the
    // window resets the unreflected hold no longer blocks admission.
    await advance(86_400_001);
    expect(await p.execute(command("after-window-reset"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")).toHaveLength(2);
  });
});

describe("reconciliation evidence", () => {
  it("keeps a pending resume's capacity across a stale archived listing", async () => {
    await stoppedPool();
    const id = [...f.boat.boxes.keys()][0]!;
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const reservation = await ledger.reserve(boatApi(f), { operation: "resume", sandboxId: id, poolId: "pool-a",
      size: "default", jobSeconds: 60, tailSeconds: 15, maxActive: 2, maxStartsPerDay: 70, minComputeHoursLeft: 1 });
    // The listing predates the resume effect: it still shows archived.
    await ledger.reconcile(boatApi(f), [{ id, state: "archived" }]);
    f.boat.boxes.get(id)!.state = "ready";
    await ledger.started(boatApi(f), reservation, id);
    const intent = ledgerIntents(f).find((i) => i.id === reservation.id);
    expect(intent).toMatchObject({ status: "running", active: true });
    expect(intent!.compute as number).toBeGreaterThan(0);
  });

  it("reconciles the ledger through one credential group only", async () => {
    const manager = f.manager();
    const base = { driverKey: "boat", companyId: COMPANY, agentId: "synthetic-principal", config: {} };
    await manager.acquire({ ...base, environmentId: "env-recon-a", issueId: "issue-a",
      executionWorkspaceId: "workspace-a", runId: "recon-a", config: { apiKey: "key-recon-a", cliproxyTunnel: false } } as never);
    await manager.acquire({ ...base, environmentId: "env-recon-b", issueId: "issue-b",
      executionWorkspaceId: "workspace-b", runId: "recon-b", config: { apiKey: "key-recon-b", cliproxyTunnel: false } } as never);
    const sandboxesBefore = f.boat.callsOf("sandboxes").length;
    const spy = vi.spyOn(AccountLedger.prototype, "reconcile");
    try {
      await manager.sweep("review-reconcile-partition", { force: true });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    // Both credential groups still sweep their own VMs.
    expect(f.boat.callsOf("sandboxes").length - sandboxesBefore).toBe(2);
  });

  it("records a definitive stop-404 in the ledger promptly", async () => {
    const manager = f.manager();
    const lease = await f.acquire(manager, "gone-vm");
    const id = lease.providerLeaseId!;
    f.boat.boxes.delete(id);
    const receipt = await manager.release({ driverKey: "boat", companyId: COMPANY, environmentId: "env-gone",
      issueId: "issue-gone-vm", executionWorkspaceId: "workspace-gone-vm", runId: "gone-vm",
      agentId: "synthetic-principal", providerLeaseId: id, leaseMetadata: lease.metadata,
      config: { apiKey: "boat_synthetic_not_a_credential", cliproxyTunnel: false } } as never, "release");
    expect(receipt).toMatchObject({ state: "stopped" });
    const intents = ledgerIntents(f);
    expect(intents.filter((i) => i.sandboxId === id).every((i) => i.status === "stopped" || !i.active)).toBe(true);
  });
});

describe("funding and accounting", () => {
  it("funds the enforced 60 s minimum TTL before creating", async () => {
    // 16 s of job+tail plus the 1 h reserve fits 3650, but the enforced 60 s
    // envelope does not: admission must refuse without dispatching.
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3650 });
    const p = f.pool();
    expect(await p.execute(command("tiny", { timeoutMs: 1_000 }))).toMatchObject({ status: "unavailable" });
    expect(f.boat.callsOf("create")).toHaveLength(0);
  });

  it("creates short commands with a TTL equal to the funded envelope", async () => {
    const p = f.pool();
    expect(await p.execute(command("tiny-ok", { timeoutMs: 1_000 }))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")[0]!.args.ttlSeconds).toBe(60);
  });

  it("closes the predecessor tail at a new resume, not at the later terminal receipt", async () => {
    f.boat.stopMode = "never";
    const run = async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; };
    const p = f.pool("tail-pool", {}, run);
    await p.execute(command("tail-a"));
    await advance(25_000); // idle stop accepted; the save is still pending
    const id = [...f.boat.boxes.keys()][0]!;
    f.boat.boxes.get(id)!.state = "archived"; // the save completes before the resume
    await p.execute(command("tail-b"));
    await advance(25_000);
    f.boat.boxes.get(id)!.state = "archived";
    await reconcile(p);
    const rows = usage(p);
    const a = rows.find((r) => r.commandId === "tail-a")!;
    const b = rows.find((r) => r.commandId === "tail-b")!;
    const aTail = a.intervals.find((i) => i.phase === "idle_tail")!;
    const bCmd = b.intervals.find((i) => i.phase === "command")!;
    expect(aTail).toBeDefined();
    expect(bCmd).toBeDefined();
    expect(Date.parse(aTail.until)).toBeLessThanOrEqual(Date.parse(bCmd.since));
  });

  it("runs the command with the funded tail when the metered upgrade does not fit", async () => {
    const p = await stoppedPool();
    f.boat.limitsResponse = limits({ starts: starts(0), creditBalanceSeconds: 3959 });
    f.boat.failNext("resume", () => {
      f.boat.limitsResponse = limits({ starts: starts(1), creditBalanceSeconds: 3959 });
      return null;
    });
    // The resume counted against the daily starts, but 285 s of extra C=300
    // tail plus the reserve no longer fits: the live VM keeps its funded tail.
    expect(await p.execute(command("metered-short"))).toMatchObject({ status: "completed" });
  });

  it("treats a stop as accepted when only the ledger write fails", async () => {
    const p = f.pool();
    await p.execute(command("stop-ledger-down"));
    f.state.failWrites = true;
    await advance(16_000);
    // The provider stop was accepted: no retry storm, and the VM stays usable.
    expect(f.boat.callsOf("stop")).toHaveLength(1);
    f.state.failWrites = false;
    await p.execute(command("stop-ledger-reuse"));
    expect(f.executions).toEqual(["stop-ledger-down", "stop-ledger-reuse"]);
    expect(f.boat.callsOf("create")).toHaveLength(1);
  });
});

describe("stop receipt persistence", () => {
  it("confirms a provider-accepted stop when the ledger write fails", async () => {
    const manager = f.manager();
    const lease = await f.acquire(manager, "stop-ledger-sweep");
    const id = lease.providerLeaseId!;
    await advance(61 * 60_000);
    // Fail only the account-journal writes; the VM store keeps working.
    const realSet = f.state.set.bind(f.state);
    type SetInput = Parameters<typeof f.state.set>[0];
    f.state.set = async (input: SetInput, value: unknown) => {
      if ((input as { namespace?: string }).namespace === "boat-account") throw new Error("synthetic ledger unavailable");
      return realSet(input, value);
    };
    try {
      const report = await manager.sweep("stop-ledger-sweep", { force: true });
      // The provider archived the VM: the sweep must report the stop even
      // though the receipt could not be persisted. Only the pre-stop ledger
      // reconcile (which cannot write either) may report an error.
      expect(report.stopped).toEqual([id]);
      expect(report.errors).toEqual(["account reservation reconciliation failed"]);
      expect(JSON.stringify(f.logs)).not.toContain("boat: stop call failed");
    } finally {
      f.state.set = realSet;
    }
    // The hold is retained fail-closed; the next reconcile converges it.
    expect(ledgerIntents(f).some((i) => i.sandboxId === id && i.active)).toBe(true);
    await new AccountLedger(f.state, f.accountId, () => Date.now()).reconcile(boatApi(f));
    expect(ledgerIntents(f).filter((i) => i.sandboxId === id).every((i) => !i.active)).toBe(true);
  });
});
