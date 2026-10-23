import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, fixture, flush, until } from "./test-support/offload-lifecycle-contract.js";
import type { Fixture, GuestIdentity } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

async function running(id = "active", timeoutMs = 120_000) {
  const gate = s.hold(`exec:${id}`);
  const pending = s.execute(command(id, { timeoutMs }));
  await until(() => s.trace.includes(`exec:${id}`));
  return { gate, pending };
}
const cancellation = (id = "active", generation = 1) =>
  s.api().cancel?.(id, "client_signal", generation).catch((error: unknown) => ({ error: String(error) }));

// Breaks caught: profile eligibility after spawn; PID-only ownership; TERM-only
// cleanup; releasing after leader exit; worker-dependent absolute deadlines.
// All descendants/watchdogs below are resource MODELS, not real cgroup proof.
describe("offload guest lifecycle: preconditions and intent", () => {
  it.each([
    [false, true], [null, true], [true, false], [true, null],
  ] as const)("fails closed before spawn when delegation=%s watchdog=%s", async (delegated, watchdog) => {
    s.guest.delegated = delegated;
    s.guest.watchdog = watchdog;
    const result = await s.execute(command("ineligible"));
    expect.soft(s.starts).toEqual([]);
    expect.soft(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.guest.actions.filter((v) => ["spawn", "term", "kill"].includes(v.kind))).toEqual([]);
  });

  it("persists complete identity and both deadlines before the command effect", async () => {
    await s.execute(command("intent"));
    expect(s.starts).toHaveLength(1);
    const before = JSON.stringify(s.starts[0]!.persisted);
    for (const [key, value] of Object.entries({
      guestBootId: "boot-a", processGroupId: 4100, cgroupPath: "/delegated/commands/intent",
      journalGeneration: 1, heartbeatDeadline: Date.parse("2026-10-23T10:00:30Z"),
      guestDeadline: Date.parse("2026-10-23T10:02:00Z"),
    })) {
      expect.soft(before, `durable ${key} before spawn`).toContain(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    }
    expect.soft(before).toContain("intent");
    const kinds = s.guest.actions.map((v) => v.kind);
    expect(kinds.indexOf("arm")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("arm")).toBeLessThan(kinds.indexOf("spawn"));
  });

  it("failed durable intent prevents spawn rather than returning a successful command", async () => {
    s.state.failWrites = true;
    await s.execute(command("no-intent")).catch(() => undefined);
    expect(s.starts).toEqual([]);
  });
});

describe("offload guest lifecycle: cancellation and descendant fencing", () => {
  it("verifies identity, sends TERM, waits five seconds, kills the cgroup and verifies empty before reuse", async () => {
    await running();
    const cancel = cancellation();
    await flush();
    expect.soft(s.guest.actions.filter((v) => v.kind === "term")).toHaveLength(1);
    expect.soft(s.guest.actions.findIndex((v) => v.kind === "inspect")).toBeGreaterThanOrEqual(0);
    await s.clock.advance(4_999);
    expect.soft(s.guest.actions.filter((v) => v.kind === "kill")).toHaveLength(0);
    expect.soft(s.guest.alive("active")).toBe(true);
    expect.soft(s.boat.callsOf("stop")).toEqual([]);
    await s.clock.advance(1);
    await cancel;
    expect.soft(s.guest.alive("active")).toBe(false);
    const actions = s.guest.actions.map((v) => v.kind);
    expect.soft(actions.filter((v) => v === "kill")).toHaveLength(1);
    expect.soft(actions.indexOf("inspect")).toBeLessThan(actions.indexOf("term"));
    expect.soft(actions.indexOf("term")).toBeLessThan(actions.indexOf("kill"));
    expect(actions.indexOf("verify")).toBeGreaterThan(actions.indexOf("kill"));
  });

  it("repeated cancellation cannot repeat a signal or restore safe fallback after execution", async () => {
    const { pending } = await running();
    const first = cancellation();
    const second = cancellation();
    await flush();
    await s.clock.advance(5_000);
    await Promise.all([first, second]);
    expect.soft(s.guest.alive("active")).toBe(false);
    expect.soft(s.guest.actions.filter((v) => v.kind === "term")).toHaveLength(1);
    expect.soft(s.guest.actions.filter((v) => v.kind === "kill")).toHaveLength(1);
    // Do not wait forever on the unfixed executor; the owned fixture drains it.
    if (!s.guest.alive("active")) {
      const result = await pending;
      expect(result).toMatchObject({ remoteStarted: true, fallbackSafe: false });
      expect(await s.api().read?.("active", 0, 65536)).toMatchObject({
        state: "cancelled", remoteStarted: true, fallbackSafe: false, result: { cancelled: true },
      });
      await cancellation();
      expect(s.guest.actions.filter((v) => v.kind === "kill")).toHaveLength(1);
    }
  });

  it.each([
    { guestBootId: "rebooted" }, { journalGeneration: 2 },
    { cgroupPath: "/delegated/unrelated" }, { processGroupId: 99999 },
  ])("quarantines identity mismatch %j without signaling unrelated processes", async (patch) => {
    const { gate, pending } = await running();
    Object.assign(s.guest.trees.get("active")!.identity, patch);
    const cancel = cancellation();
    await s.clock.advance(5_000);
    await cancel;
    expect.soft(s.guest.actions.filter((v) => ["term", "kill"].includes(v.kind))).toEqual([]);
    expect.soft(s.guest.alive("active")).toBe(true);
    gate.resolve();
    await pending;
    const before = s.starts.length;
    const next = await s.execute(command("must-not-reuse", { queueTimeoutMs: 0 }));
    expect.soft(next).toMatchObject({ status: "unavailable" });
    expect(s.starts).toHaveLength(before);
  });

  it("unobservable ownership quarantines rather than signaling or releasing", async () => {
    const { gate, pending } = await running();
    s.guest.observable = false;
    const cancel = cancellation();
    await s.clock.advance(5_000);
    await cancel;
    expect.soft(s.guest.actions.filter((v) => ["term", "kill"].includes(v.kind))).toEqual([]);
    gate.resolve();
    await pending;
    await s.execute(command("probe", { queueTimeoutMs: 0 }));
    expect(s.starts.map((v) => v.commandId)).toEqual(["active"]);
  });

  it.each(["kill", "verify"])("a %s failure cannot return the slot to service", async (failure) => {
    const { gate, pending } = await running();
    s.guest.failKill = failure === "kill";
    s.guest.failVerify = failure === "verify";
    const cancel = cancellation();
    await s.clock.advance(5_000);
    await cancel;
    gate.resolve();
    await pending;
    await s.execute(command("probe", { queueTimeoutMs: 0 }));
    expect(s.starts.map((v) => v.commandId)).toEqual(["active"]);
    expect(s.boat.callsOf("stop")).toEqual([]);
  });

  it("normal leader exit still cleans descendants outside the original process group", async () => {
    s.descendants();
    const pending = s.execute(command("normal-exit"));
    await until(() => s.trace.includes("exec:normal-exit"));
    for (let i = 0; i < 20; i += 1) await flush();
    await s.clock.advance(5_000);
    expect.soft(s.guest.alive("normal-exit")).toBe(false);
    expect.soft(s.guest.actions.some((v) => v.kind === "verify")).toBe(true);
    await pending;
  });

  it("stale generation cancellation cannot terminate or release a newer reservation", async () => {
    await running();
    const oldIdentity: GuestIdentity = { ...s.guest.trees.get("active")!.identity };
    s.guest.trees.get("active")!.identity.journalGeneration = oldIdentity.journalGeneration + 1;
    const cancel = cancellation("active", oldIdentity.journalGeneration);
    await s.clock.advance(5_000);
    await cancel;
    expect.soft(s.guest.actions.filter((v) => ["term", "kill"].includes(v.kind))).toEqual([]);
    expect(s.guest.alive("active")).toBe(true);
  });
});

describe("offload guest lifecycle: interest and absolute deadlines", () => {
  it("expires client interest at thirty seconds and cleans without any run-end hook", async () => {
    await running();
    await s.clock.advance(29_999);
    expect(s.guest.actions.filter((v) => v.kind === "term")).toEqual([]);
    await s.clock.advance(1);
    expect.soft(s.guest.actions.filter((v) => v.kind === "term")).toHaveLength(1);
    await s.clock.advance(5_000);
    expect(s.guest.alive("active")).toBe(false);
  });

  it("five-second heartbeats renew interest, but status reads do not", async () => {
    await running();
    for (let n = 0; n < 7; n += 1) {
      await s.clock.advance(5_000);
      await s.api().heartbeat?.("active", 1);
    }
    expect.soft(s.guest.alive("active")).toBe(true);
    expect.soft(s.guest.actions.filter((v) => v.kind === "term")).toEqual([]);
    for (let n = 0; n < 6; n += 1) {
      await s.clock.advance(5_000);
      await s.api().read?.("active", 0, 65536);
    }
    expect.soft(s.guest.actions.filter((v) => v.kind === "term")).toHaveLength(1);
    await s.clock.advance(5_000);
    expect(s.guest.alive("active")).toBe(false);
  });

  it("a late heartbeat does not resurrect expired or cancelled work", async () => {
    await running();
    await s.clock.advance(30_000);
    await s.api().heartbeat?.("active", 1);
    await s.clock.advance(5_000);
    expect.soft(s.guest.alive("active")).toBe(false);
    await s.api().heartbeat?.("active", 1);
    await s.clock.advance(30_000);
    expect.soft(s.guest.alive("active")).toBe(false);
    expect(s.starts).toHaveLength(1);
  });

  it("execution timeout uses identity-fenced subtree cleanup despite recent heartbeats", async () => {
    await running("active", 10_000);
    await s.clock.advance(5_000);
    await s.api().heartbeat?.("active", 1);
    await s.clock.advance(10_000);
    expect.soft(s.guest.alive("active")).toBe(false);
    expect(s.guest.actions.some((v) => v.kind === "verify")).toBe(true);
  });

  it("an outside watchdog stops the complete subtree at the absolute deadline after worker death", async () => {
    await running("active", 10_000);
    s.clock.crashWorker();
    await s.clock.advance(9_999);
    expect(s.guest.alive("active")).toBe(true);
    await s.clock.advance(1);
    expect.soft(s.guest.alive("active")).toBe(false);
    expect(s.guest.actions.filter((v) => v.kind === "watchdog").map((v) => v.at)).toEqual([Date.parse("2026-10-23T10:00:10Z")]);
  });
});

describe("offload guest lifecycle: incremental output", () => {
  it("start returns before execution finishes, with no second execution on read", async () => {
    s.hold("exec:started");
    const receipt = await s.api().start?.(command("started"));
    for (let i = 0; i < 20; i += 1) await flush();
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["started"]);
    expect.soft(receipt).toMatchObject({ commandId: "started", fallbackSafe: false, result: null });
    await s.api().read?.("started", 0, 65536);
    expect(s.starts).toHaveLength(1);
  });

  it("preserves arbitrary bytes on both streams and cursor replay has no spawn effects", async () => {
    const stdout = Uint8Array.from([0, 255, 195, 40, 10]);
    const stderr = Uint8Array.from([254, 0, 13, 10]);
    s.output([["stdout", stdout], ["stderr", stderr]]);
    await s.execute(command("binary"));
    const first = await s.api().read?.("binary", 0, 65536);
    const replay = await s.api().read?.("binary", 0, 65536);
    expect.soft(first?.events).toEqual([
      { seq: 1, stream: "stdout", dataBase64: "AP/DKAo=" },
      { seq: 2, stream: "stderr", dataBase64: "/gANCg==" },
    ]);
    expect.soft(first?.nextCursor).toBe(2);
    expect.soft(replay).toEqual(first);
    expect(s.starts).toHaveLength(1);
  });

  it("bounds each read to sixty-four KiB without losing the remainder", async () => {
    s.output(Array.from({ length: 70 }, () => ["stdout", new Uint8Array(1024).fill(255)]));
    await s.execute(command("bounded-output"));
    const first = await s.api().read?.("bounded-output", 0, 65536);
    const second = first ? await s.api().read?.("bounded-output", first.nextCursor, 65536) : undefined;
    const bytes = (events: typeof first) => Buffer.concat((events?.events ?? []).map((v) => Buffer.from(v.dataBase64, "base64")));
    expect.soft(bytes(first).length).toBe(65_536);
    expect.soft(bytes(second).length).toBe(6_144);
    expect(Buffer.concat([bytes(first), bytes(second)])).toEqual(Buffer.alloc(71_680, 255));
  });

  it("a cursor excludes already consumed events without changing retained output", async () => {
    s.output([["stdout", Buffer.from("first")], ["stderr", Buffer.from("second")]]);
    await s.execute(command("cursor"));
    const tail = await s.api().read?.("cursor", 1, 65536);
    expect.soft(tail?.events).toEqual([{ seq: 2, stream: "stderr", dataBase64: "c2Vjb25k" }]);
    const full = await s.api().read?.("cursor", 0, 65536);
    expect.soft(full?.events).toHaveLength(2);
    expect(s.starts).toHaveLength(1);
  });
});
