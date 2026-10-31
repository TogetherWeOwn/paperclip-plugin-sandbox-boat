import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import type { AccountUsageRow, AdmissionRequest } from "./account-ledger.js";
import type { BoatApiLike } from "./boat-client.js";
import { parseDriverConfig } from "./config.js";
import { responseError } from "./test-support/fake-boat.js";
import { EPOCH, advance, command, fixture, limits, starts } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });
const api = () => f.boat as unknown as BoatApiLike;
const req: AdmissionRequest = { operation: "create", size: "default", jobSeconds: 60, tailSeconds: 15,
  maxActive: 2, maxStartsPerDay: 70, minComputeHoursLeft: 1, poolId: "safety" };
const identity = (id: string) => ({ commandId: id, runId: `run-${id}`, cardId: `card-${id}`, repoId: "public-source" });
function journal() {
  const entry = f.state.snapshot().find(([key]) => key.includes("boat-account"));
  expect(entry).toBeDefined();
  return JSON.parse(entry![1]) as { intents: Array<Record<string, unknown>>; usage: AccountUsageRow[] };
}

describe("review safety mutation pins", () => {
  it("refuses an unfunded TTL extension before issuing a provider update", async () => {
    const manager = f.manager();
    const lease = await f.acquire(manager, "extension", { autoStopMinutes: 1 });
    const id = lease.providerLeaseId!;
    const oldDeadline = f.boat.boxes.get(id)!.archiveAfter;
    await advance(31_000); // Extension is due; cached limits can no longer authorize it.
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3601 });
    const updates = f.boat.callsOf("update").length;
    const intents = journal().intents;
    await manager.maybeExtend(parseDriverConfig({ apiKey: "boat_synthetic_not_a_credential", autoStopMinutes: 1, cliproxyTunnel: false }), id);
    expect(f.boat.callsOf("update")).toHaveLength(updates);
    expect(f.boat.boxes.get(id)!.archiveAfter).toEqual(oldDeadline);
    expect(journal().intents).toEqual(intents);
    expect(JSON.stringify(f.logs)).toContain("could not extend the auto-stop deadline");
  });

  it.each([[422], [500]])("settles the warm hold when a TTL extension update fails (%i)", async (status) => {
    const manager = f.manager();
    const lease = await f.acquire(manager, "extension-fails", { autoStopMinutes: 1 });
    const id = lease.providerLeaseId!;
    await advance(31_000);
    f.boat.update = async () => { throw responseError(status, { code: "synthetic_update_failure" }); };
    const before = journal().intents.length;
    await manager.maybeExtend(parseDriverConfig({ apiKey: "boat_synthetic_not_a_credential", autoStopMinutes: 1, cliproxyTunnel: false }), id);
    const intents = journal().intents;
    expect(intents).toHaveLength(before + 1);
    const warm = intents.at(-1)!;
    // Even a definitive refusal keeps the hold: it carries the predecessor's
    // remaining deadline, which the still-running VM can bill until it stops.
    expect(warm).toMatchObject({ operation: "warm", sandboxId: id, status: "ambiguous" });
    expect(warm.compute).toBeGreaterThan(0);
    expect(JSON.stringify(f.logs)).toContain("could not extend the auto-stop deadline");
    // The VM's terminal receipt then settles the hold, which an unsettled intent never got.
    f.boat.boxes.get(id)!.state = "archived";
    await manager.sweep("api", { force: true });
    const settled = journal().intents.find((i) => i.id === warm.id)!;
    expect(settled.status).toBe("stopped");
  });

  it("persists a SHA-256 payload digest, never raw argv or environment canaries", async () => {
    const argvCanary = "SYNTHETIC_ARGV_CANARY_do_not_persist";
    const envCanary = "SYNTHETIC_ENV_CANARY_do_not_persist";
    const p = f.pool("digest");
    expect(await p.execute(command("digest", { argv: ["tool", `--token=${argvCanary}`], env: { TEST_TOKEN: envCanary } })))
      .toMatchObject({ status: "completed" });
    const row = journal().usage.find((r) => r.commandId === "digest")!;
    expect(row.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(f.state.snapshot());
    expect(serialized).not.toContain(argvCanary);
    expect(serialized).not.toContain(envCanary);
    expect(serialized).not.toContain("--token=");
  });

  it("updates the provider deadline from 75 to 360 seconds before a counted-resume command runs", async () => {
    const p = f.pool("metered-tail", {}, async (id, cmd) => {
      if (cmd.commandId === "counted-resume") {
        expect(f.boat.boxes.get(id)!.ttlSeconds).toBe(360);
        expect(f.boat.boxes.get(id)!.archiveAfter!.getTime()).toBe(Date.now() + 360_000);
      }
      return { exitCode: 0, seconds: 0 };
    });
    await p.execute(command("seed")); await advance(15_000);
    f.boat.limitsResponse = limits({ starts: starts(1) });
    const resume = f.boat.resume.bind(f.boat);
    f.boat.resume = async (args) => {
      const result = await resume(args);
      f.boat.limitsResponse = limits({ starts: starts(2) });
      return result;
    };
    expect(await p.execute(command("counted-resume"))).toMatchObject({ status: "completed", exitCode: 0 });
    expect(f.boat.callsOf("resume")[0]!.args.ttlSeconds).toBe(75);
    expect(f.boat.callsOf("update").at(-1)!.args).toMatchObject({ ttlSeconds: 360 });
    expect(journal().usage.find((r) => r.commandId === "counted-resume")).toMatchObject({ observedStartsDelta: 1 });
  });

  it.each([undefined, "synthetic-provider-scope"])("rotates more than 100 historical bills across ledger reconstruction (scope: %s)", async (scope) => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now(), scope);
    const ranges = new Map<string, { since: number; until: number }>();
    for (let n = 0; n < 101; n++) {
      const id = `historical-${n}`;
      f.boat.addSandbox({ id, state: "archived" });
      const since = Date.now();
      const reservation = await ledger.reserve(api(), { ...req, operation: "warm", sandboxId: id, jobSeconds: 1, tailSeconds: 0,
        minComputeHoursLeft: 0, command: identity(id) });
      await ledger.started(api(), reservation, id);
      vi.setSystemTime(since + 1_000);
      await ledger.finished(reservation, false);
      await ledger.stopped(id);
      ranges.set(id, { since, until: Date.now() });
    }
    let late = false;
    f.boat.usage = async (args) => {
      f.boat.calls.push({ method: "usage", args });
      const range = ranges.get(String(args.sandboxId))!;
      const since = Math.max(range.since, args.since == null ? range.since : Date.parse(String(args.since)));
      const until = Math.min(range.until, args.until == null ? range.until : Date.parse(String(args.until)));
      const seconds = Math.max(0, until - since) / 1000 * (late && args.sandboxId === "historical-100" ? 2 : 1);
      return { ok: true, type: "sandbox.usage", sandboxId: String(args.sandboxId), sandboxType: "default", billingMultiplier: 1,
        seconds, dollars: seconds * 0.00001, secondsPerDollar: 100_000, since: new Date(since), until: new Date(until), running: false };
    };
    await ledger.reconcile(api());
    expect(ledger.usage("safety").filter((r) => r.meterProvenance === "provider")).toHaveLength(100);
    expect(ledger.usage("safety").find((r) => r.commandId === "historical-100")).toMatchObject({ meterProvenance: "pending" });
    late = true;
    const recovered = new AccountLedger(f.state, f.accountId, () => Date.now(), scope);
    await recovered.reconcile(api());
    expect(recovered.usage("safety").filter((r) => r.meterProvenance === "provider")).toHaveLength(101);
    expect(recovered.usage("safety").find((r) => r.commandId === "historical-100"))
      .toMatchObject({ meterProvenance: "provider", seconds: 2, dollars: 0.00002 });
    expect(new Set(recovered.usage("safety").map((r) => r.usageRecordId)).size).toBe(101);
  });

  it("restores the predecessor's open tail when slow warm-handoff persistence fails freshness revalidation", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const first = await ledger.reserve(api(), { ...req, command: identity("predecessor") });
    const id = (await f.boat.create()).sandbox.id as string;
    await ledger.started(api(), first, id);
    vi.setSystemTime(EPOCH + 10_000);
    await ledger.finished(first, false);
    const before = journal();
    expect(before.usage[0]).toMatchObject({ tailSince: EPOCH + 10_000 });
    vi.setSystemTime(EPOCH + 15_000);
    f.state.beforeWrite = async () => {
      f.state.beforeWrite = undefined;
      vi.setSystemTime(Date.now() + 6_001);
      f.boat.limitsResponse = limits({ creditBalanceSeconds: 3600 });
    };
    await expect(ledger.reserve(api(), { ...req, operation: "warm", sandboxId: id, command: identity("refused-handoff") }))
      .rejects.toThrow();
    expect(journal().usage).toEqual(before.usage);
    expect(journal().intents).toEqual(before.intents);
    expect(ledger.usage("safety")).toEqual(before.usage);
    expect(f.boat.callsOf("update")).toHaveLength(0);
    expect(f.boat.callsOf("resume")).toHaveLength(0);
  });
});
