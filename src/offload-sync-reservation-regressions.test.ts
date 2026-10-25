import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandKey, OffloadJournal } from "./offload-journal.js";
import { command, DiskState, EPOCH, fixture, flush, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";

// Additional regressions only; independent acceptance assertions stay intact.
let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

describe("sync receipt plumbing", () => {
  it("passes the collected payload intact and retains the staging receipt on reads and replay", async () => {
    const cmd = command("payload");
    const collected = { files: [{ path: "Cargo.lock", dataBase64: "cmVtb3Rl" }] };
    const staged = { state: "conflict" as const, changedPaths: ["Cargo.lock"],
      conflictPaths: ["Cargo.lock"], artifactId: "artifact-payload" };
    const stage = vi.fn(async (_vm: string, _cmd: typeof cmd, _collected: unknown) => staged);
    const journal = new OffloadJournal({ journalStore: s.state.store(),
      guestReceipts: { bootId: async () => "boot-a", read: async () => null },
      resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + 86_400_000 }),
      sync: { push: async () => {}, collect: async () => collected, stage },
    }, s.clock.now, { hold: async () => {}, release: async () => {}, cancel: async () => {} });
    const result = await journal.execute(cmd, async () => {
      const raw = await journal.run("sync-vm", cmd, async () => ({ exitCode: 0, seconds: 1 }));
      return await journal.finish(cmd, { status: "completed", commandId: cmd.commandId,
        sandboxId: "sync-vm", warm: "cold", queueWaitMs: 0, dollars: 0, ...raw });
    });
    expect(stage).toHaveBeenCalledWith("sync-vm", cmd, collected);
    expect(stage.mock.calls[0]?.[2]).toBe(collected);
    const receipt = structuredClone(staged);
    staged.changedPaths.push("later-adapter-mutation");
    expect(result).toMatchObject({ syncBack: receipt });
    expect(await journal.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({ result: { syncBack: receipt } });
    const launch = vi.fn(async () => { throw new Error("must not relaunch"); });
    expect(await journal.execute(cmd, launch)).toEqual(result);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("sync reservations across cancellation and recovery", () => {
  it.each([false, true])("does not authorize local fallback until a cancelled push settles (push fails: %s)", async (fails) => {
    const cmd = command("push-cancel-read");
    const gate = s.hold(`push:${cmd.commandId}`);
    if (fails) s.fail.add(`push:${cmd.commandId}`);
    const first = s.execute(cmd);
    await until(() => s.trace.includes(`push:${cmd.commandId}`));

    const cancellation = await s.executor.cancel(cmd.commandId, "client_signal", 1);
    expect.soft(cancellation).toMatchObject({ state: "syncing_in", remoteStarted: false, fallbackSafe: false });
    expect.soft(await s.executor.read(cmd.commandId)).toMatchObject({ state: "syncing_in", fallbackSafe: false });
    expect.soft(await s.state.store().get(commandKey(cmd))).toMatchObject({
      state: "syncing_in", cancelRequested: "client_signal", fallbackSafe: false,
    });
    // Repeated cancellation must not turn an in-progress transfer into a safe handoff.
    expect.soft(await s.executor.cancel(cmd.commandId, "client_signal", 1)).toMatchObject({ fallbackSafe: false });

    gate.resolve();
    const result = await first;
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true });
    expect(await s.executor.read(cmd.commandId)).toMatchObject({ state: "not_started", fallbackSafe: true });
    expect(await s.execute(cmd)).toEqual(result);
    expect(s.starts).toEqual([]);
  });

  it.each(["push", "collect", "stage"])("retains the workspace through cancelled %s even with a spare VM", async (phase) => {
    const gate = s.hold(`${phase}:cancelled`);
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("cancelled"), ex);
    await until(() => s.trace.includes(`${phase}:cancelled`));
    await ex.cancel("cancelled", "client_signal", 1);
    const blocked = await s.execute(command("blocked", { queueTimeoutMs: 0 }), ex);
    expect(blocked).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    gate.resolve();
    const result = await first;
    if (phase === "push") {
      expect(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    } else {
      expect(result).toMatchObject({ remoteStarted: true, fallbackSafe: false, exitCode: 130, cancelled: true,
        syncBack: { state: "staged", artifactId: "artifact-cancelled" } });
      expect(await ex.read("cancelled")).toMatchObject({ state: "cancelled", result: { cancelled: true } });
    }
    expect(await s.execute(command("cancelled"), ex)).toEqual(result);
  });

  it("does not overwrite cancellation while the post-exit syncing-out commit is pending", async () => {
    const gate = s.hold("persist:syncing-out");
    const stage = s.hold("stage:commit-race");
    const set = s.state.set.bind(s.state);
    let held = false;
    s.state.set = async (key, value) => {
      if (key.namespace === "guest-test-journal" && value && typeof value === "object"
        && "state" in value && value.state === "syncing_out" && !("cancelRequested" in value)) {
        held = true;
        await gate.promise;
      }
      await set(key, value);
    };
    const first = s.execute(command("commit-race"));
    await until(() => held);
    const cancellation = s.executor.cancel("commit-race", "client_signal", 1);
    for (let n = 0; n < 20; n += 1) await flush();
    gate.resolve();
    await cancellation;
    await until(() => s.trace.includes("stage:commit-race"));
    expect.soft(await s.state.store().get(commandKey(command("commit-race")))).toMatchObject({ cancelRequested: "client_signal" });
    stage.resolve();
    expect(await first).toMatchObject({ remoteStarted: true, fallbackSafe: false, cancelled: true, exitCode: 130 });
    expect(await s.executor.read("commit-race")).toMatchObject({ state: "cancelled" });
  });

  it.each(["push", "collect", "stage"])("recovers the workspace hold from an interrupted %s before using a spare VM", async (phase) => {
    const gate = s.hold(`${phase}:interrupted`);
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("interrupted"), ex);
    await until(() => s.trace.includes(`${phase}:interrupted`));
    s.clock.crashWorker();
    const restarted = s.make({ maxOffloadVms: 2, queueLimit: 0 }, new DiskState(s.state.path));
    await restarted.recover();
    expect(await s.execute(command("probe"), restarted)).toMatchObject({ status: "unavailable" });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    gate.resolve();
    await first;
  });

  it.each(["collect", "stage"])("a failed %s holds its workspace after settlement but permits another workspace", async (phase) => {
    s.fail.add(`${phase}:failed`);
    const ex = s.make({ maxOffloadVms: 2 });
    expect(await s.execute(command("failed"), ex)).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(await s.execute(command("same-workspace", { queueTimeoutMs: 0 }), ex)).toMatchObject({ status: "unavailable" });
    expect(await s.execute(command("other-workspace", { executionWorkspaceId: "workspace-b", cardId: "card-b" }), ex))
      .toMatchObject({ status: "completed" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["failed", "other-workspace"]);
  });
});

describe("compatible pool scheduling", () => {
  it.each([
    { companyId: "company-b" }, { repoId: "repo-b" },
    { profileId: "rust-other" }, { trustDomainId: "untrusted-fork" },
  ])("does not resume a recovered stopped VM across a pool boundary: %j", async (patch) => {
    const ex = s.make({ maxOffloadVms: 2 });
    await s.execute(command("first"), ex);
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    const restarted = s.make({ maxOffloadVms: 2 }, new DiskState(s.state.path));
    expect(await s.execute(command("other", patch), restarted)).toMatchObject({ status: "completed" });
    expect(s.starts[1]?.sandboxId).not.toBe(s.starts[0]?.sandboxId);
    expect(s.boat.callsOf("resume")).toEqual([]);
  });

  it("resumes a recovered stopped VM when all pool bindings match", async () => {
    await s.execute(command("first"));
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    const restarted = s.make({}, new DiskState(s.state.path));
    expect(await s.execute(command("other"), restarted)).toMatchObject({ status: "completed" });
    expect(s.starts[1]?.sandboxId).toBe(s.starts[0]?.sandboxId);
    expect(s.boat.callsOf("resume")).toHaveLength(1);
  });

  it("refuses a full incompatible pool rather than borrowing it on release", async () => {
    const gate = s.hold("exec:first");
    const first = s.execute(command("first"));
    await until(() => s.trace.includes("exec:first"));
    const other = s.execute(command("other", { trustDomainId: "untrusted-fork" }));
    for (let n = 0; n < 20; n += 1) await flush();
    gate.resolve();
    const refused = await other;
    expect(refused).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true });
    await first;
    expect(await s.execute(command("other", { trustDomainId: "untrusted-fork" }))).toEqual(refused);
    expect(s.starts.map((start) => start.commandId)).toEqual(["first"]);
  });

  it("lets an eligible waiter pass a head blocked on another workspace", async () => {
    const a = s.hold("exec:a");
    const b = s.hold("exec:b");
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("a"), ex);
    const second = s.execute(command("b", { executionWorkspaceId: "workspace-b", cardId: "card-b" }), ex);
    await until(() => s.trace.includes("exec:a") && s.trace.includes("exec:b"));
    const blocked = s.execute(command("a-next"), ex);
    const eligible = s.execute(command("c", { executionWorkspaceId: "workspace-c", cardId: "card-c" }), ex);
    for (let n = 0; n < 20; n += 1) await flush();
    b.resolve();
    await eligible;
    expect(s.guest.alive("a")).toBe(true);
    expect(s.starts.map((start) => start.commandId)).toEqual(["a", "b", "c"]);
    a.resolve();
    await Promise.all([first, second, blocked]);
    expect(s.starts.map((start) => start.commandId)).toEqual(["a", "b", "c", "a-next"]);
  });
});
