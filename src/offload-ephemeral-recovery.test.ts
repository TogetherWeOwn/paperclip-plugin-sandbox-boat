import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OffloadPoolStore } from "./offload-pool.js";
import { command, harness, hostKey, receipt, testAccount, type RecordV1 } from "./test-support/durable-offload.js";

let root: string;
let h: ReturnType<typeof harness>;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "ephemeral-recovery-"));
  h = harness(root);
});
afterEach(async () => { h.crash(); await rm(root, { recursive: true, force: true }); });

async function unfinishedEphemeral(state: "running" | "syncing_out") {
  const account = testAccount();
  const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
  const first = h.openExecutor(account);
  (first.executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
  const cmd = command("unfinished-ephemeral");
  await first.executor.execute(cmd);
  const saved = await first.store.get(hostKey(cmd)) as RecordV1;
  // Recreate a pre-completion crash boundary with the pre-execution policy,
  // without any old worker continuing transport or output collection.
  const { config, vms } = await poolStore.loadDoc();
  await poolStore.save(config, vms.map((vm) => ({ ...vm, busy: true, deleteOnRelease: true })));
  await first.store.set(hostKey(cmd), { ...saved, state, result: null, resultAt: null });
  h.setReceipt(receipt("started", saved.identity!));
  h.crash();
  const restarted = h.openExecutor(account);
  (restarted.executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
  return { ...restarted, poolStore, cmd, vm: saved.identity!.sandboxId };
}

it.each(["running", "syncing_out"] as const)("does not turn ephemeral policy into deletion while a recovered %s command is unresolved", async (state) => {
  const { executor, store, cmd, vm, poolStore } = await unfinishedEphemeral(state);
  await executor.sweep();
  expect(h.boat.boxes.get(vm)?.state).toBe("ready");
  expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);
  expect(h.boat.callsOf("stop")).toHaveLength(0);
  expect(await store.get(hostKey(cmd))).toMatchObject({ state, resultAt: null });
  expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, quarantined: true, deleteOnRelease: true }]);
  expect(h.attempts).toHaveLength(1);
});

it.each([false, true])("settles an archived unfinished ephemeral journal before retiring its deletion owner (already pending: %s)", async (alreadyPending) => {
  const { executor, store, cmd, vm, poolStore } = await unfinishedEphemeral("syncing_out");
  if (alreadyPending) {
    const { config, vms } = await poolStore.loadDoc();
    await poolStore.save(config, vms.map((entry) => ({ ...entry, quarantined: true, deletePending: true })));
  }
  h.boat.boxes.get(vm)!.state = "archived";
  store.fail = (key, value) => key === hostKey(cmd) && (value as RecordV1).state === "unknown";
  await executor.sweep();
  expect(h.boat.callsOf("deleteSandbox")).toHaveLength(alreadyPending ? 1 : 0);
  expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, quarantined: true }]);
  expect(await store.get(hostKey(cmd))).toMatchObject({ state: "syncing_out", resultAt: null });
  store.fail = null;
  await executor.sweep();
  expect(await store.get(hostKey(cmd))).toMatchObject({ state: "unknown", resultAt: h.clock.t });
  await executor.sweep(); // the terminal reconciliation queued pending deletion
  expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual(alreadyPending ? [vm, vm] : [vm]);
  expect(await poolStore.load()).toEqual([]);
  expect(h.attempts).toHaveLength(1);
});

it("recovers ephemeral deletion after all completion-time pool writes fail, without new work", async () => {
  const account = testAccount();
  const poolStore = new OffloadPoolStore(account.state, account.accountId, account.poolId);
  const set = account.state.set.bind(account.state);
  let failPool = false;
  let executions = 0;
  account.state.set = async (key, value) => {
    if (failPool && key.namespace === "boat-offload-pool") throw new Error("synthetic pool write failure");
    return set(key, value);
  };
  const open = (first = false) => {
    const opened = h.openExecutor({
      ...account,
      config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0, queueTimeoutMs: 0,
        ephemeralRepos: ["repo-1"] },
      ...(first ? { runCommand: async () => {
        executions += 1;
        failPool = true; // busy ownership is durable; every completion pool write fails
        return { exitCode: 0, seconds: 2 };
      } } : {}),
    });
    (opened.executor as unknown as { poolStore: OffloadPoolStore }).poolStore = poolStore;
    return opened;
  };
  const first = open(true);
  const cmd = command("ephemeral-write-outage");
  await expect(first.executor.execute(cmd)).rejects.toThrow("synthetic pool write failure");
  const [vm] = [...h.boat.boxes.keys()];
  expect(await first.store.get(hostKey(cmd))).toMatchObject({ state: "completed" });
  expect(await poolStore.load()).toMatchObject([{ sandboxId: vm, busy: true, deleteOnRelease: true }]);
  expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);
  expect(h.boat.boxes.get(vm!)?.state).toBe("archived");
  await expect(first.executor.sweep()).rejects.toThrow("synthetic pool write failure");
  expect(h.boat.callsOf("deleteSandbox")).toHaveLength(0);

  h.crash();
  failPool = false;
  const restarted = open();
  await restarted.executor.sweep();
  expect(h.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([vm]);
  expect(h.boat.boxes.has(vm!)).toBe(false);
  expect(await poolStore.load()).toEqual([]);
  expect(h.boat.callsOf("create")).toHaveLength(1);
  expect(h.boat.callsOf("resume")).toHaveLength(0);
  expect(executions).toBe(1);
  expect(h.attempts).toHaveLength(0);
  expect(await restarted.store.get(hostKey(cmd))).toMatchObject({ state: "completed" });
  expect(restarted.executor.getUsage()).toMatchObject([{ sandboxId: vm, outcome: "completed", stoppedAt: h.clock.t }]);
  await restarted.executor.sweep();
  expect(h.boat.callsOf("deleteSandbox")).toHaveLength(1);
  expect(restarted.executor.getUsage()).toHaveLength(1);
});
