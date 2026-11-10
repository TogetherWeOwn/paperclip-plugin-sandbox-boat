import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OffloadPoolStore } from "./offload-pool.js";
import { command, harness, hostKey, testAccount } from "./test-support/durable-offload.js";

let root: string;
let h: ReturnType<typeof harness>;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "ephemeral-recovery-"));
  h = harness(root);
});
afterEach(async () => { h.crash(); await rm(root, { recursive: true, force: true }); });

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
