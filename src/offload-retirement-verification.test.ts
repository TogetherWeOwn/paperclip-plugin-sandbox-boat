import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { responseError } from "./test-support/fake-boat.js";
import { command, harness, hostKey, receipt, type RecordV1 } from "./test-support/durable-offload.js";

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
