import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OffloadPoolStore } from "./offload-pool.js";
import { responseError } from "./test-support/fake-boat.js";
import { command, harness, hostKey, receipt, testAccount, type RecordV1 } from "./test-support/durable-offload.js";

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
    await open()[cleanup]();
    expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm, vm]);
    expect(h.boat.boxes.has(vm!)).toBe(false);
    expect(await poolStore.load()).toEqual([]);
    expect(h.attempts).toHaveLength(0);
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
