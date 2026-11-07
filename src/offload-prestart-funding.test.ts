import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFLOAD_PRE_START_ALLOWANCE_S } from "./offload.js";
import { DELEGATION_WAIT_WINDOW_MS } from "./offload-ssh.js";
import { command, completed, fixture, type Fixture, type RunContext } from "./test-support/offload-lifecycle-contract.js";

// The provider TTL a claim sets starts before the journal's sync push and the
// guest preflight (with its bounded delegation wait) have run. These tests pin
// that the claim funds that pre-start time, and that a pre-start slower than
// the allowance trims the guest deadline instead of leaving it past the TTL.

const TAIL_S = 15;
const HOUR_MS = 3_600_000;

describe("offload funds pre-start time in the provider TTL", () => {
  let s: Fixture;
  beforeEach(async () => { s = await fixture(); });
  afterEach(async () => { await s.dispose(); });

  /** An executor whose transport records the provider deadline the command
   * actually runs under next to the guest deadline the host armed. */
  function executor() {
    const runs: Array<{ commandId: string; guestDeadline: number; archiveAfter: number; at: number }> = [];
    const ex = s.make({}, s.state, async (sandboxId, cmd, context?: RunContext) => {
      runs.push({ commandId: cmd.commandId, guestDeadline: context!.identity.guestDeadline,
        archiveAfter: s.boat.boxes.get(sandboxId)!.archiveAfter!.getTime(), at: s.clock.t });
      return completed();
    });
    return { ex, runs };
  }

  /** Pre-start work that takes `ms` on the (virtual) host clock. */
  function slowPreflight(ms: number) {
    s.guest.preflight = async () => {
      s.clock.t += ms;
      return { cgroupV2Delegated: true, outsideWatchdogVerified: true };
    };
  }

  it("covers at least the delegation-wait hard cap plus its last probe", () => {
    expect(OFFLOAD_PRE_START_ALLOWANCE_S * 1000).toBeGreaterThanOrEqual(DELEGATION_WAIT_WINDOW_MS + 15_000);
  });

  it("a long-timeout command whose prepare waits the full delegation window keeps its whole timeout inside the TTL", async () => {
    const { ex, runs } = executor();
    // The full window plus the last 15 s probe, on a fresh VM.
    slowPreflight(DELEGATION_WAIT_WINDOW_MS + 15_000);
    const createdAt = s.clock.t;
    expect(await s.execute(command("long", { timeoutMs: HOUR_MS }), ex)).toMatchObject({ status: "completed", warm: "cold" });

    expect(s.boat.callsOf("create")[0]!.args.ttlSeconds).toBe(HOUR_MS / 1000 + OFFLOAD_PRE_START_ALLOWANCE_S + TAIL_S);
    // The guest still gets the command's full timeout, and its deadline plus
    // the funded tail ends no later than the provider deadline.
    expect(s.guest.preparedTimeouts).toEqual([HOUR_MS]);
    const [run] = runs;
    expect(run!.guestDeadline).toBe(createdAt + DELEGATION_WAIT_WINDOW_MS + 15_000 + HOUR_MS);
    expect(run!.guestDeadline + TAIL_S * 1000).toBeLessThanOrEqual(run!.archiveAfter);
  });

  it("funds the same allowance when a warm VM is updated and when a stopped VM is resumed", async () => {
    const { ex, runs } = executor();
    await s.execute(command("seed"), ex);
    slowPreflight(DELEGATION_WAIT_WINDOW_MS + 15_000);
    expect(await s.execute(command("warm", { timeoutMs: HOUR_MS }), ex)).toMatchObject({ status: "completed", warm: "warm" });
    expect(s.boat.callsOf("update").at(-1)!.args.ttlSeconds).toBe(HOUR_MS / 1000 + OFFLOAD_PRE_START_ALLOWANCE_S + TAIL_S);

    await s.clock.advance((TAIL_S + 1) * 1000);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(await s.execute(command("resumed", { timeoutMs: HOUR_MS }), ex)).toMatchObject({ status: "completed", warm: "cold" });
    expect(s.boat.callsOf("resume").at(-1)!.args.ttlSeconds).toBe(HOUR_MS / 1000 + OFFLOAD_PRE_START_ALLOWANCE_S + TAIL_S);

    expect(s.guest.preparedTimeouts.slice(1)).toEqual([HOUR_MS, HOUR_MS]);
    for (const run of runs) expect(run.guestDeadline + TAIL_S * 1000).toBeLessThanOrEqual(run.archiveAfter);
  });

  it("trims the guest deadline to the funded window when pre-start outruns the allowance", async () => {
    const { ex, runs } = executor();
    const slowMs = (OFFLOAD_PRE_START_ALLOWANCE_S + 60) * 1000;
    slowPreflight(slowMs);
    const createdAt = s.clock.t;
    expect(await s.execute(command("slow", { timeoutMs: HOUR_MS }), ex)).toMatchObject({ status: "completed" });

    const fundedUntil = createdAt + HOUR_MS + OFFLOAD_PRE_START_ALLOWANCE_S * 1000;
    expect(s.guest.preparedTimeouts).toEqual([fundedUntil - (createdAt + slowMs)]);
    const [run] = runs;
    expect(run!.guestDeadline).toBe(fundedUntil);
    expect(run!.guestDeadline + TAIL_S * 1000).toBeLessThanOrEqual(run!.archiveAfter);
  });

  it("refuses before spawn when pre-start used up the whole funded window", async () => {
    const { ex, runs } = executor();
    slowPreflight((60 + OFFLOAD_PRE_START_ALLOWANCE_S) * 1000);
    const result = await s.execute(command("exhausted", { timeoutMs: 60_000 }), ex);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "guest lifecycle prepare failed before the command could start (OFFLOAD_GUEST_INELIGIBLE)" });
    expect(runs).toEqual([]);
    expect(s.guest.preparedTimeouts).toEqual([]);
    const warn = s.logs.find((entry) => entry.message === "boat offload command failed before transport");
    expect(warn?.meta).toMatchObject({ step: "guest lifecycle prepare", code: "OFFLOAD_GUEST_INELIGIBLE",
      detail: "funded_window_elapsed" });
  });
});
