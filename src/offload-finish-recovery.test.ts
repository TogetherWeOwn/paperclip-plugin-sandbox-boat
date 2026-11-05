import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import { command, DiskState, EPOCH, fixture, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

function failFinish(commandId: string, state = "completed", scope: { runId?: string; always?: boolean } = {}) {
  const set = s.state.set.bind(s.state);
  let failed = false;
  s.state.set = async (key, value) => {
    const record = value as { commandId?: string; state?: string; command?: { runId?: string } };
    if ((scope.always || !failed) && key.namespace === "guest-test-journal" && record.commandId === commandId && record.state === state
      && (scope.runId === undefined || record.command?.runId === scope.runId)) {
      failed = true;
      throw new Error("lost finish write");
    }
    await set(key, value);
  };
}

describe("lost finish integration recovery", () => {
  it("finishes accounting and recovers capacity without replaying the guest", async () => {
    const cmd = command("lost-finish");
    const gate = s.hold("exec:lost-finish");
    failFinish(cmd.commandId);
    const running = s.execute(cmd);
    await until(() => s.starts.length === 1);
    await s.clock.advance(1_000);
    gate.resolve();
    await expect(running).rejects.toThrow("lost finish write");
    await s.clock.advance(4_000);
    await s.executor.sweep();
    expect(await s.executor.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({ state: "completed" });
    expect(s.executor.getUsage().find((row) => row.commandId === cmd.commandId)).toMatchObject({
      outcome: "completed", expectedSeconds: 1,
      intervals: [{ since: new Date(s.clock.t - 5_000).toISOString(), until: new Date(s.clock.t - 4_000).toISOString(), phase: "command" }],
    });
    expect(await s.execute(command("after-recovery"))).toMatchObject({ status: "completed" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["lost-finish", "after-recovery"]);
  });

  it("keeps recovery fenced and retries when the accounting write also fails", async () => {
    const cmd = command("lost-finish-ledger");
    failFinish(cmd.commandId);
    await expect(s.execute(cmd)).rejects.toThrow("lost finish write");
    const set = s.state.set.bind(s.state);
    s.state.set = async (key, value) => {
      const doc = value as { usage?: Array<{ outcome?: string }> };
      if (key.namespace === "boat-account" && doc.usage?.some((row) => row.outcome === "completed")) {
        throw new Error("finish accounting outage");
      }
      await set(key, value);
    };
    await s.executor.collectGarbage();
    expect(s.executor.getUsage().find((row) => row.commandId === cmd.commandId)?.outcome).not.toBe("completed");
    await s.executor.sweep(); // may stop billing, but must not reuse the fenced VM
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archived");
    s.state.set = set;
    await s.executor.sweep();
    expect(s.executor.getUsage().find((row) => row.commandId === cmd.commandId)).toMatchObject({
      outcome: "completed", tailSince: null,
    });
    expect(await s.execute(command("after-ledger-recovery"))).toMatchObject({ status: "completed" });
  });

  it("does not repeat finish accounting after a disposition-only failure", async () => {
    const cmd = command("lost-disposition");
    const gate = s.hold("exec:lost-disposition");
    failFinish(cmd.commandId);
    const running = s.execute(cmd);
    await until(() => s.starts.length === 1);
    await s.clock.advance(1_000);
    gate.resolve();
    await expect(running).rejects.toThrow("lost finish write");
    const set = s.state.set.bind(s.state);
    let failed = false;
    s.state.set = async (key, value) => {
      const doc = value as { vms?: Array<{ workspaceKey?: string | null }> };
      if (!failed && key.namespace === "boat-offload-pool" && doc.vms?.[0]?.workspaceKey === null) {
        failed = true;
        throw new Error("disposition persistence outage");
      }
      await set(key, value);
    };
    await s.clock.advance(4_000);
    await s.executor.sweep();
    expect(failed).toBe(true);
    const tails = () => s.executor.getUsage().find((row) => row.commandId === cmd.commandId)!.intervals
      .filter((interval) => interval.phase === "idle_tail");
    const accounted = tails();
    expect(accounted).toEqual([{ since: new Date(s.clock.t - 4_000).toISOString(), until: new Date(s.clock.t).toISOString(), phase: "idle_tail" }]);
    await s.executor.sweep();
    expect(tails()).toEqual(accounted);
  });

  it("frees a recovered refusal's real queue slot without dispatching the refused command", async () => {
    const executor = s.make({ queueLimit: 1 });
    const gate = s.hold("exec:occupant");
    const occupant = s.execute(command("occupant"), executor);
    await until(() => s.starts.length === 1);
    const set = s.state.set.bind(s.state);
    let failed = false;
    s.state.set = async (key, value) => {
      const record = value as { commandId?: string; state?: string };
      if (!failed && record.commandId === "refused" && record.state === "not_started") {
        failed = true;
        throw new Error("lost refusal write");
      }
      await set(key, value);
    };
    const refused = s.execute(command("refused", { executionWorkspaceId: "workspace-b", queueTimeoutMs: 1_000 }), executor);
    const rejection = expect(refused).rejects.toThrow("lost refusal write");
    await until(() => [...s.clock.timers.values()].some((timer) => timer.at === s.clock.t + 1_000));
    await s.clock.advance(1_000);
    await rejection;
    await executor.collectGarbage();
    const next = s.execute(command("queued-after-recovery", { executionWorkspaceId: "workspace-c", queueTimeoutMs: 10_000 }), executor);
    await until(() => [...s.clock.timers.values()].some((timer) => timer.at === s.clock.t + 10_000));
    gate.resolve();
    await occupant;
    expect(await next).toMatchObject({ status: "completed" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["occupant", "queued-after-recovery"]);
  });

  it("recovers the pool before cancellation can acquire the journal startup lock", async () => {
    const cmd = command("restart-cancel");
    s.fail.add("exec:restart-cancel");
    expect(await s.execute(cmd)).toMatchObject({ status: "unknown" });
    s.clock.crashWorker();
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    const disk = new DiskState(s.state.path);
    const get = disk.get.bind(disk);
    const reads: string[] = [];
    disk.get = async (key) => { reads.push(key.namespace ?? ""); return await get(key); };
    const executor = s.make({ queueLimit: 0 }, disk);
    await executor.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
    expect(reads.indexOf("boat-offload-pool")).toBeGreaterThanOrEqual(0);
    expect(reads.indexOf("boat-offload-pool")).toBeLessThan(reads.indexOf("guest-test-journal"));
    await executor.sweep();
    expect(s.starts).toHaveLength(1);
  });

  it("does not stop a VM whose guest is still populated or unobservable after a lost unknown-finish write", async () => {
    const cmd = command("lost-unknown");
    s.descendants();
    failFinish(cmd.commandId, "unknown", { always: true });
    const running = s.execute(cmd);
    const rejection = expect(running).rejects.toThrow("lost finish write");
    await until(() => s.starts.length === 1);
    s.guest.failKill = true;
    s.guest.failVerify = true;
    s.guest.observable = false; // cleanup/observe fails while the guest is populated
    await s.clock.advance(5_000);
    await rejection;
    expect(s.guest.alive(cmd.commandId)).toBe(true);
    for (let n = 0; n < 3; n += 1) {
      await s.clock.advance(10_000); // past idle-stop, before the 120s guest deadline
      await s.executor.collectGarbage();
      await s.executor.sweep();
    }
    expect(s.guest.alive(cmd.commandId)).toBe(true);
    expect(s.boat.callsOf("stop")).toEqual([]);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).not.toBe("archived");
    expect(await s.execute(command("probe", { queueTimeoutMs: 0 }))).not.toMatchObject({ status: "completed" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["lost-unknown"]);
  });

  it("keeps command and idle-tail accounting exact when a ledger outage spans the stopping sweep", async () => {
    const cmd = command("lost-finish-outage-stop");
    const gate = s.hold("exec:lost-finish-outage-stop");
    failFinish(cmd.commandId);
    const running = s.execute(cmd);
    await until(() => s.starts.length === 1);
    await s.clock.advance(1_000);
    gate.resolve();
    await expect(running).rejects.toThrow("lost finish write");
    const set = s.state.set.bind(s.state);
    s.state.set = async (key, value) => {
      const doc = value as { usage?: Array<{ outcome?: string }> };
      if (key.namespace === "boat-account" && doc.usage?.some((row) => row.outcome === "completed")) {
        throw new Error("finish accounting outage");
      }
      await set(key, value);
    };
    const stopAt = s.clock.t + 4_000;
    await s.clock.advance(4_000);
    await s.executor.sweep(); // stops the VM while finish accounting is down
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archived");
    await s.clock.advance(10_000); // time after the stop is never billable
    s.state.set = set;
    await s.executor.sweep();
    await s.executor.collectGarbage();
    await s.executor.sweep();
    const row = s.executor.getUsage().find((usage) => usage.commandId === cmd.commandId)!;
    expect(row).toMatchObject({ outcome: "completed", expectedSeconds: 1, tailSince: null });
    expect(row.intervals).toEqual([
      { since: new Date(EPOCH).toISOString(), until: new Date(EPOCH + 1_000).toISOString(), phase: "command" },
      { since: new Date(EPOCH + 1_000).toISOString(), until: new Date(stopAt).toISOString(), phase: "idle_tail" },
    ]);
    expect(await s.execute(command("after-outage"))).toMatchObject({ status: "completed" });
  });

  it("recovered finish keeps ID-only behavior and the ambiguity marker for one commandId in distinct scopes", async () => {
    const ex = s.make({ maxOffloadVms: 2 });
    const a = command("shared-id");
    const b = command("shared-id", { runId: "run-b", executionWorkspaceId: "workspace-b", queueTimeoutMs: 600_000 });
    failFinish(a.commandId, "completed", { runId: a.runId });
    await expect(s.execute(a, ex)).rejects.toThrow("lost finish write");
    const maps = ex as unknown as { knownCommands: Map<string, unknown> };
    expect(maps.knownCommands.get(a.commandId)).toMatchObject({ runId: "run-a" });
    const gate = s.hold("exec:shared-id"); // run-b stays live and unsettled
    const other = s.execute(b, ex);
    await until(() => maps.knownCommands.get(a.commandId) === null);
    await expect(ex.heartbeat(a.commandId)).rejects.toThrow("OFFLOAD_COMMAND_SCOPE_REQUIRED");
    await ex.collectGarbage();
    await ex.sweep();
    expect(await ex.readCommand(a.companyId, a.runId, a.commandId)).toMatchObject({ state: "completed" });
    // run-b must still be live on its own VM, never settled/refused.
    expect(s.starts.map((start) => start.sandboxId).length).toBe(2);
    expect(await ex.readCommand(b.companyId, b.runId, b.commandId)).toMatchObject({ state: expect.stringMatching(/^(starting|running)$/) });
    // Recovery of run-a is a normal finish: marker and key are untouched.
    expect(maps.knownCommands.has(a.commandId)).toBe(true);
    expect(maps.knownCommands.get(a.commandId)).toBeNull();
    await expect(ex.heartbeat(a.commandId)).rejects.toThrow("OFFLOAD_COMMAND_SCOPE_REQUIRED");
    await expect(ex.cancel(a.commandId, "client_signal")).rejects.toThrow("OFFLOAD_COMMAND_SCOPE_REQUIRED");
    // Scoped calls keep working for each scope.
    await expect(ex.heartbeatCommand(b.companyId, b.runId, b.commandId)).resolves.not.toThrow();
    gate.resolve();
    await other;
  });

  it("recovered single-scope finish leaves the ID-only lookup usable (settled callback does not delete it)", async () => {
    const cmd = command("single-scope");
    failFinish(cmd.commandId);
    await expect(s.execute(cmd)).rejects.toThrow("lost finish write");
    const maps = s.executor as unknown as { knownCommands: Map<string, unknown> };
    // execute() rejected, so it never reached its terminal-result cleanup.
    expect(maps.knownCommands.get(cmd.commandId)).toMatchObject({ runId: cmd.runId });
    await s.executor.collectGarbage();
    await s.executor.sweep();
    expect(await s.executor.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({ state: "completed" });
    expect(maps.knownCommands.get(cmd.commandId)).toMatchObject({ runId: cmd.runId });
    // ID-only calls still resolve their scope; the journal then answers (a terminal command
    // may refuse, but never with the scope-required error).
    for (const call of [() => s.executor.heartbeat(cmd.commandId), () => s.executor.cancel(cmd.commandId, "client_signal")]) {
      await call().catch((error: Error) => { expect(error.message).not.toContain("OFFLOAD_COMMAND_SCOPE_REQUIRED"); });
    }
  });

  it("bills a recovered unknown command through the observed stop, not only to its unknown result", async () => {
    const cmd = command("unknown-bills-to-stop");
    s.descendants();
    const healthy = s.state.set;
    failFinish(cmd.commandId, "unknown", { always: true }); // persistent journal outage
    const running = s.execute(cmd);
    const rejection = expect(running).rejects.toThrow("lost finish write");
    await until(() => s.starts.length === 1);
    s.guest.failKill = true;
    s.guest.observable = false;
    await s.clock.advance(5_000); // unknown transport result at +5s
    await rejection;
    await s.clock.advance(115_000); // guest watchdog empties the cgroup at +120s
    expect(s.guest.alive(cmd.commandId)).toBe(false);
    s.guest.observable = true;
    await s.executor.sweep(); // provider stop, still inside the journal outage
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    const stoppedAt = s.clock.t;
    await s.clock.advance(1_000);
    s.state.set = healthy; // journal recovers at +121s
    await s.executor.collectGarbage();
    await s.executor.sweep();
    const row = s.executor.getUsage().find((usage) => usage.commandId === cmd.commandId)!;
    const billedMs = row.intervals.reduce((sum, i) => sum + Date.parse(i.until) - Date.parse(i.since), 0);
    expect(row.tailSince).toBeNull();
    expect(Math.max(...row.intervals.map((i) => Date.parse(i.until)))).toBeGreaterThanOrEqual(stoppedAt);
    expect(Math.max(...row.intervals.map((i) => Date.parse(i.until)))).toBeLessThanOrEqual(stoppedAt + 1_000);
    expect(billedMs).toBeGreaterThanOrEqual(120_000);
    expect(billedMs).toBeLessThanOrEqual(121_000);
    const ledger = new AccountLedger(s.state, `guest-test:${s.root}`, s.clock.now);
    expect(await ledger.monthVmSeconds(cmd.companyId, s.clock.t)).toBeGreaterThanOrEqual(120);
  });

  it("caps a recovered idle tail at the funded tail plus grace when recovery runs a day late", async () => {
    const cmd = command("day-late-tail");
    const gate = s.hold("exec:day-late-tail");
    failFinish(cmd.commandId);
    const running = s.execute(cmd);
    const rejection = expect(running).rejects.toThrow("lost finish write");
    await until(() => s.starts.length === 1);
    await s.clock.advance(1_000);
    const finishedAt = s.clock.t;
    gate.resolve();
    await rejection;
    await s.clock.advance(86_400_000); // recovery is delayed a whole day
    await s.executor.sweep(); // recovers the journal and accounting
    await s.clock.advance(20_000); // funded 15s tail elapses after recovery
    await s.executor.sweep();
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    const row = s.executor.getUsage().find((usage) => usage.commandId === cmd.commandId)!;
    expect(row).toMatchObject({ outcome: "completed", tailSince: null });
    const tails = row.intervals.filter((interval) => interval.phase === "idle_tail");
    expect(tails.length).toBeGreaterThan(0);
    for (const tail of tails) expect(Date.parse(tail.until)).toBeLessThanOrEqual(finishedAt + (15 + 300) * 1000);
    const ledger = new AccountLedger(s.state, `guest-test:${s.root}`, s.clock.now);
    expect(await ledger.monthVmSeconds(cmd.companyId, s.clock.t)).toBeLessThanOrEqual(1 + 15 + 300);
  });
});
