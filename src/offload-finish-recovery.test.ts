import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, DiskState, fixture, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

function failFinish(commandId: string) {
  const set = s.state.set.bind(s.state);
  let failed = false;
  s.state.set = async (key, value) => {
    const record = value as { commandId?: string; state?: string };
    if (!failed && key.namespace === "guest-test-journal" && record.commandId === commandId && record.state === "completed") {
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
});
