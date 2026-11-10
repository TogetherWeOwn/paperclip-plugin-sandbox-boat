import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OffloadPoolStore } from "./offload-pool.js";
import { responseError } from "./test-support/fake-boat.js";
import { command, harness, settled, hostKey, receipt, testAccount, type RecordV1 } from "./test-support/durable-offload.js";

let root: string;
let h: ReturnType<typeof harness>;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "retirement-verification-"));
  h = harness(root);
});
afterEach(async () => { h.crash(); await rm(root, { recursive: true, force: true }); });

async function replayReleasedVm() {
  const cmd = command("original");
  const original = h.openExecutor();
  await original.executor.execute(cmd);
  h.crash();
  // Reopen the durable syncing-out boundary after execution, without rerunning
  // the command. The provider VM is deliberately still ready after the crash.
  const saved = await original.store.get(hostKey(cmd)) as RecordV1;
  await original.store.set(hostKey(cmd), { ...saved, state: "syncing_out", result: null, resultAt: null });
  h.setReceipt(receipt("result", saved.identity!));
  const recovered = h.openExecutor().executor;
  await recovered.recover();
  expect(await recovered.execute(cmd)).toMatchObject({ status: "completed" });
  expect(h.attempts).toHaveLength(1);
  return { executor: recovered, vm: saved.identity!.sandboxId };
}
const incompatible = (id: string) => command(id, { repoId: "another-repository" });

describe("retirement requires observed provider termination", () => {
  it("keeps an incompatible replay tracked when its stop is unconfirmed", async () => {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    const { executor } = h.openExecutor(account);
    (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    expect(await executor.execute(command("cmd-1"))).toMatchObject({ status: "unavailable" });
    const [vm] = [...h.boat.boxes.keys()];

    // A failed replay stop retains deletion ownership, not a reusable cache.
    h.boat.failNext("stop", () => responseError(500, { code: "internal" }));
    expect(await executor.execute(incompatible("cmd-2"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.boxes.size).toBe(1);
    expect(h.boat.callsOf("create")).toHaveLength(2);
    expect(h.boat.callsOf("stop")).toHaveLength(1);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    expect(await executor.execute(command("cmd-compatible"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("resume")).toHaveLength(0);
    expect(h.attempts).toHaveLength(0);

    // Sweep owns the pending delete even when the stop reply was lost. Only
    // confirmed deletion frees the slot for a command on a fresh VM.
    await executor.sweep();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(h.boat.boxes.has(vm!)).toBe(false);
    expect(await poolStore.load()).toEqual([]);
    const third = await executor.execute(incompatible("cmd-3"));
    expect(third).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("stop")).toHaveLength(1);
    expect(h.boat.boxes.size).toBe(1);
    expect(third).toMatchObject({ sandboxId: [...h.boat.boxes.keys()][0] });
    expect(h.attempts).toHaveLength(1);
  });

  it("sweeps a failed incompatible lost-create delete after worker restart without replaying work", async () => {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    // The journal harness has no guest adapter, so wire pool persistence too:
    // reopening the journal alone does not model recovery of owned VMs.
    const open = () => {
      const executor = h.openExecutor(account).executor;
      (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
      return executor;
    };
    const first = open();
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    expect(await first.execute(command("lost-create"))).toMatchObject({ status: "unavailable" });
    const [vm] = [...h.boat.boxes.keys()];
    h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    expect(await first.execute(incompatible("delete-pending"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.boxes.get(vm!)?.state).toBe("archived");
    expect(h.boat.callsOf("create")).toHaveLength(2); // lost reply and same-key recovery
    expect(h.attempts).toHaveLength(0);
    expect(await poolStore.load()).toMatchObject([
      { sandboxId: vm, deletePending: true, quarantined: true },
    ]);

    h.crash();
    const recovered = open();
    await recovered.sweep();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm, vm]);
    expect(h.boat.boxes.has(vm!)).toBe(false);
    expect(await poolStore.load()).toEqual([]);
    expect(h.boat.callsOf("create")).toHaveLength(2);
    expect(h.attempts).toHaveLength(0);
    expect(await recovered.execute(incompatible("replacement"))).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("create")).toHaveLength(3);
    expect(h.attempts).toHaveLength(1);
  });

  it.each(["sweep", "shutdown"] as const)("preserves recovered delete ownership through pool-write failures and %s restart", async (cleanup) => {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    const open = () => {
      const executor = h.openExecutor(account).executor;
      (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
      return executor;
    };
    const first = open();
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    expect(await first.execute(command("lost-create"))).toMatchObject({ status: "unavailable" });
    const [vm] = [...h.boat.boxes.keys()];

    // Allow the recovered and confirmed-stopped snapshots, then fail the
    // pending-delete write and every later pool write, without losing journals.
    const set = account.state.set.bind(account.state);
    let failPool = false;
    let savedStopped = false;
    account.state.set = async (key, value) => {
      if (key.namespace === "boat-offload-pool") {
        if (failPool) throw new Error("synthetic pool write failure");
        await set(key, value);
        const doc = value as { vms: Array<{ sandboxId: string; stopped: boolean }> };
        if (doc.vms.some((entry) => entry.sandboxId === vm && entry.stopped)) {
          savedStopped = true;
          failPool = true;
        }
        return;
      }
      return set(key, value);
    };
    h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    expect(await first.execute(incompatible("delete-pending"))).toMatchObject({ status: "unavailable" });
    expect(savedStopped).toBe(true);
    expect(h.boat.boxes.get(vm!)?.state).toBe("archived");
    expect(await poolStore.load()).toMatchObject([
      { sandboxId: vm, stopped: true, deletePending: true, quarantined: true },
    ]);
    // No retry may outrun durable intent while pool writes remain unavailable.
    await expect(first[cleanup]()).rejects.toThrow("synthetic pool write failure");
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);

    h.crash();
    const recovered = open();
    expect(await recovered.execute(command("compatible-after-crash"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("resume")).toHaveLength(0);
    expect(h.boat.callsOf("create")).toHaveLength(2);
    expect(h.attempts).toHaveLength(0);
    await expect(recovered.sweep()).rejects.toThrow("synthetic pool write failure");
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);

    account.state.set = set;
    await recovered.sweep(); // storage is healthy, but the queued DELETE fails
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    h.crash();
    const restarted = open();
    await restarted.recover();
    await restarted[cleanup]();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm, vm]);
    expect(h.boat.boxes.has(vm!)).toBe(false);
    expect(await poolStore.load()).toEqual([]);
    expect(h.attempts).toHaveLength(0);
  });

  // Queue behind the timer callback's admission section without sweeping:
  // scheduleIdleStop invokes withAdmission synchronously from the timer, so an
  // empty section enqueued afterwards completes only once that callback has.
  async function drainTimerAdmission(executor: object) {
    await (executor as unknown as { withAdmission(fn: () => Promise<void>): Promise<void> }).withAdmission(async () => {});
  }
  async function pendingDeleteAfterFailedStop() {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    const { executor } = h.openExecutor(account);
    (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    expect(await executor.execute(command("lost-create"))).toMatchObject({ status: "unavailable" });
    const [vm] = [...h.boat.boxes.keys()];
    h.boat.failNext("stop", responseError(500, { code: "internal" }));
    expect(await executor.execute(incompatible("replay"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.boxes.get(vm!)?.state).toBe("ready");
    expect(h.boat.callsOf("stop")).toHaveLength(1);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    return { executor, poolStore, vm: vm! };
  }
  function expectNoNewWork(createCalls: number) {
    expect(h.boat.callsOf("create")).toHaveLength(createCalls);
    expect(h.boat.callsOf("resume")).toHaveLength(0);
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);
    expect(h.attempts).toHaveLength(0);
  }

  it("force-stops a pending-delete quarantined VM from the 1s timer without sweep or new work, retaining ownership", async () => {
    const { executor, poolStore, vm } = await pendingDeleteAfterFailedStop();
    await h.advance(1000);
    await drainTimerAdmission(executor);
    expect(h.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([vm, vm]);
    expect(h.boat.boxes.get(vm)?.state).toBe("archived");
    expectNoNewWork(2);
    // A confirmed stop ends compute only: only confirmed deletion releases it.
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    expect(await executor.execute(command("compatible"))).toMatchObject({ status: "unavailable" });
    expectNoNewWork(2);
    await executor.sweep();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(h.boat.callsOf("stop")).toHaveLength(2);
    expect(await poolStore.load()).toEqual([]);
  });

  it("keeps retrying the forced stop from timers while it fails, without sweep, and retains pending delete", async () => {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    const { executor } = h.openExecutor(account);
    (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    await executor.execute(command("lost-create"));
    const [vm] = [...h.boat.boxes.keys()];
    h.boat.failNext("stop", responseError(500, { code: "internal" }));
    h.boat.failNext("stop", responseError(500, { code: "internal" }));
    await executor.execute(incompatible("replay"));
    await h.advance(1000);
    await drainTimerAdmission(executor);
    expect(h.boat.callsOf("stop")).toHaveLength(2);
    expect(h.boat.boxes.get(vm!)?.state).toBe("ready");
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    await h.advance(30_000); // covers the bounded backoff, whatever its first step
    await drainTimerAdmission(executor);
    expect(h.boat.callsOf("stop")).toHaveLength(3);
    expect(h.boat.boxes.get(vm!)?.state).toBe("archived");
    expectNoNewWork(2);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
  });

  it("retains pending-delete quarantine when the timer stop recovers but sweep deletion keeps failing", async () => {
    const { executor, poolStore, vm } = await pendingDeleteAfterFailedStop();
    await h.advance(1000);
    await drainTimerAdmission(executor);
    expect(h.boat.boxes.get(vm)?.state).toBe("archived");
    h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    await executor.sweep();
    await executor.sweep();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm, vm]);
    expect(h.boat.boxes.has(vm)).toBe(true);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    expect(await executor.execute(incompatible("blocked"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("create")).toHaveLength(2);
    expect(h.attempts).toHaveLength(0);
    await executor.sweep(); // provider recovers: only now is the slot freed
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(3);
    expect(h.boat.boxes.has(vm)).toBe(false);
    expect(await poolStore.load()).toEqual([]);
    expect(await executor.execute(incompatible("replacement"))).toMatchObject({ status: "completed" });
  });

  it("retains ownership when both the first stop and sweep deletion fail, then converges via timer stop and later delete", async () => {
    const { executor, poolStore, vm } = await pendingDeleteAfterFailedStop();
    h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    h.boat.failNext("stop", responseError(500, { code: "internal" }));
    await executor.sweep(); // both cleanup endpoints still fail
    expect(h.boat.boxes.get(vm)?.state).toBe("ready");
    expect(h.boat.callsOf("create")).toHaveLength(2);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    await h.advance(30_000);
    await drainTimerAdmission(executor);
    expect(h.boat.callsOf("stop").length).toBeGreaterThanOrEqual(2);
    expect(h.boat.boxes.get(vm)?.state).toBe("archived");
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(1); // timer never deletes
    expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
    await executor.sweep();
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(2);
    expect(await poolStore.load()).toEqual([]);
    expect(h.attempts).toHaveLength(0);
  });

  describe("ephemeral delete failure stop attempts", () => {
    const ephemeralConfig = { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0, queueTimeoutMs: 0, ephemeralRepos: ["repo-1"] };

    it("issues one stop and a bounded timer retry when DELETE and the first stop both fail", async () => {
      const account = testAccount();
      const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
      const { executor } = h.openExecutor({ ...account, config: ephemeralConfig });
      (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
      h.boat.failNext("deleteSandbox", responseError(500, { code: "internal" }));
      h.boat.failNext("stop", responseError(500, { code: "internal" }));
      expect(await executor.execute(command("ephemeral-1"))).toMatchObject({ status: "completed" });
      const [vm] = [...h.boat.boxes.keys()];
      expect(h.boat.callsOf("deleteSandbox")).toHaveLength(1);
      expect(h.boat.callsOf("stop")).toHaveLength(1);
      expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, deletePending: true, quarantined: true }]);
      await h.advance(1000);
      await drainTimerAdmission(executor);
      expect(h.boat.callsOf("stop")).toHaveLength(2);
      expect(h.boat.callsOf("deleteSandbox")).toHaveLength(1);
      expect(h.boat.boxes.get(vm!)?.state).toBe("archived");
    });

    it("still stops once when the first deletion fence cannot be saved", async () => {
      const account = testAccount();
      const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
      const set = account.state.set.bind(account.state);
      const { executor } = h.openExecutor({
        ...account, config: ephemeralConfig,
        sync: {
          push: async () => {}, stage: async () => {}, markSuspect: async () => {},
          collect: async () => {
            account.state.set = async (key, value) => {
              if (key.namespace === "boat-offload-pool") throw new Error("synthetic pool write failure");
              return set(key, value);
            };
          },
        },
      });
      (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
      await settled(executor.execute(command("ephemeral-fence")));
      expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);
      expect(h.boat.callsOf("stop")).toHaveLength(1);
    });
  });

  it("does not stop or delete a recovered VM before its first deletion fence is saved", async () => {
    const account = testAccount();
    const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
    const executor = h.openExecutor(account).executor;
    (executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
    h.boat.failNext("create", (args) => h.boat.loseCreateReply(args));
    await executor.execute(command("lost-create"));
    const [vm] = [...h.boat.boxes.keys()];
    const set = account.state.set.bind(account.state);
    account.state.set = async (key, value) => {
      if (key.namespace === "boat-offload-pool") throw new Error("synthetic pool write failure");
      return set(key, value);
    };
    expect(await executor.execute(incompatible("delete-pending"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("stop")).toHaveLength(0);
    await expect(executor.sweep()).rejects.toThrow("synthetic pool write failure");
    expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);
    expect(await poolStore.load()).toMatchObject([{ sandboxId: "", quarantined: true }]);
    account.state.set = set;
    await executor.sweep();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(await poolStore.load()).toEqual([]);
  });

  it("stops a replay-released running VM before replacing its pool slot", async () => {
    const { executor, vm } = await replayReleasedVm();
    expect(h.boat.boxes.get(vm)?.state).toBe("ready");
    expect(await executor.execute(incompatible("replacement"))).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(h.boat.boxes.has(vm)).toBe(false); // retired VMs are deleted, not left archived
    expect(h.attempts).toHaveLength(2);
  });

  it.each(["archiving", "unreadable", "wrong-id"])("retains a replay-released %s VM until termination can be verified", async (mode) => {
    const { executor, vm } = await replayReleasedVm();
    if (mode === "archiving") h.boat.boxes.get(vm)!.state = "archiving";
    if (mode === "unreadable") h.boat.failNext("get", new Error("provider state unavailable"));
    if (mode === "wrong-id") {
      const get = h.boat.get.bind(h.boat);
      h.boat.get = async (args) => {
        const answer = await get(args);
        return { ...answer, sandbox: { ...answer.sandbox, id: "unrelated-vm", state: "archived" } };
      };
    }
    expect(await executor.execute(incompatible("pending"))).toMatchObject({
      status: "unavailable", reason: "incompatible pool retirement pending; reconciliation required",
    });
    expect(h.boat.callsOf("create")).toHaveLength(1);
    expect(h.boat.callsOf("stop")).toHaveLength(0);
    expect(h.attempts).toHaveLength(1);
  });

  it("retries an unverified retirement and stops the original VM once it is observable", async () => {
    const { executor, vm } = await replayReleasedVm();
    h.boat.failNext("get", new Error("provider unavailable"));
    expect(await executor.execute(incompatible("pending"))).toMatchObject({ status: "unavailable" });
    await h.advance(1000);
    // Timer reconciliation may need several fsync-backed ledger writes.
    await executor.sweep();
    expect(h.boat.boxes.get(vm)?.state).toBe("archived");
    expect(await executor.execute(incompatible("after-observation"))).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(h.boat.callsOf("create")).toHaveLength(2);
  });

  it("does not replace a replay-released VM on asynchronous stop acceptance alone", async () => {
    const { executor, vm } = await replayReleasedVm();
    h.boat.stopMode = "never";
    expect(await executor.execute(incompatible("pending"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([vm]);
    expect(h.boat.callsOf("create")).toHaveLength(1);
    h.boat.boxes.get(vm)!.state = "archived";
    expect(await executor.execute(incompatible("confirmed"))).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("create")).toHaveLength(2);
  });

  it.each(["archived", "deleted", "404"])("accepts authoritative %s evidence without sending another stop", async (mode) => {
    const { executor, vm } = await replayReleasedVm();
    if (mode === "404") h.boat.boxes.delete(vm);
    else h.boat.boxes.get(vm)!.state = mode;
    expect(await executor.execute(incompatible("replacement"))).toMatchObject({ status: "completed" });
    expect(h.boat.callsOf("get").some((call) => call.args.sandboxId === vm)).toBe(true);
    expect(h.boat.callsOf("stop")).toHaveLength(0);
    expect(h.boat.callsOf("create")).toHaveLength(2);
  });

  it("does not infer deletion from an unrelated provider error", async () => {
    const { executor } = await replayReleasedVm();
    h.boat.failNext("get", responseError(403, { code: "forbidden" }));
    expect(await executor.execute(incompatible("pending"))).toMatchObject({ status: "unavailable" });
    expect(h.boat.callsOf("create")).toHaveLength(1);
    expect(h.boat.callsOf("stop")).toHaveLength(0);
  });
});
