import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, DiskState, EPOCH, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });
const restart = () => s.make({ queueLimit: 0 }, new DiskState(s.state.path));

async function interruptBeforeStopRpc() {
  await s.execute(command("idle"));
  s.clock.crashWorker();
  const [encoded, raw] = Object.entries(await s.state.all())
    .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
  const doc = raw as { vms: Array<{ stopping: boolean; stopRequestedAt: number | null }> };
  doc.vms[0]!.stopping = true;
  doc.vms[0]!.stopRequestedAt = EPOCH + 15_000;
  await s.state.set(JSON.parse(encoded) as Parameters<typeof s.state.set>[0], doc);
  await s.clock.advance(15_000);
}

describe("stop recovery review regressions", () => {
  it("reissues a durable stop intent whose worker died before sending the RPC", async () => {
    await interruptBeforeStopRpc();
    const ex = restart();
    await ex.sweep();
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archived");
    expect(ex.getUsage()).toMatchObject([{ stopRequestedAt: EPOCH + 15_000, stoppedAt: EPOCH + 15_000, stopLagMs: 0 }]);
    expect(s.starts.map((v) => v.commandId)).toEqual(["idle"]);
  });

  it("keeps a lost stop reply fenced until a later sweep observes termination", async () => {
    s.boat.stopMode = "stays_up";
    const stop = s.boat.stop.bind(s.boat);
    s.boat.stop = async (args) => {
      await stop(args);
      throw new Error("reply lost after the provider accepted stop");
    };
    await s.execute(command("lost-stop-reply"));
    await s.clock.advance(15_000);
    expect(await s.execute(command("too-early"))).toMatchObject({ status: "unavailable" });
    expect(s.starts.map((v) => v.commandId)).toEqual(["lost-stop-reply"]);
    s.boat.stop = stop;
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    await s.executor.sweep();
    expect(await s.execute(command("safe-resume"))).toMatchObject({ status: "completed", warm: "cold" });
  });

  it.each(["404", "deleted"])("retires a pending VM with authoritative %s evidence instead of resuming it", async (mode) => {
    s.boat.stopMode = "never";
    await s.execute(command("removed"));
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    const id = s.starts[0]!.sandboxId;
    if (mode === "404") s.boat.boxes.delete(id);
    else s.boat.boxes.get(id)!.state = "deleted";
    const ex = restart();
    await ex.sweep();
    expect(await s.execute(command("replacement"), ex)).toMatchObject({ status: "completed" });
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(ex.getUsage().find((v) => v.commandId === "removed"))
      .toMatchObject({ stoppedAt: EPOCH + 15_000, stopLagMs: 0 });
  });

  it.each(["sweep", "admission"])("repairs stop telemetry through %s after storage recovers, preserving the original observation time", async (mode) => {
    await s.execute(command("ledger-outage"));
    const set = s.state.set.bind(s.state);
    let failed = false;
    s.state.set = async (key, value) => {
      if (key.namespace === "boat-account") {
        failed = true;
        throw new Error("transient ledger write failure");
      }
      await set(key, value);
    };
    await s.clock.advance(15_000);
    expect(failed).toBe(true);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    s.clock.crashWorker();
    s.state.set = set;
    await s.clock.advance(7_000);
    const ex = restart();
    if (mode === "sweep") await ex.sweep();
    else expect(await s.execute(command("next-reservation"), ex)).toMatchObject({ status: "completed" });
    expect(ex.getUsage().find((row) => row.commandId === "ledger-outage")).toMatchObject({
      commandId: "ledger-outage", stopRequestedAt: EPOCH + 15_000,
      stoppedAt: EPOCH + 15_000, stopLagMs: 0,
    });
  });

  it.each(["wrong-id", "not-ok"])("does not release capacity on a %s terminal stop reply", async (mode) => {
    s.boat.stopMode = "never";
    const stop = s.boat.stop.bind(s.boat);
    s.boat.stop = async (args) => {
      const reply = await stop(args);
      return { ...reply, ok: mode !== "not-ok", sandbox: {
        ...reply.sandbox, id: mode === "wrong-id" ? "different-vm" : args.sandboxId, state: "archived",
      } };
    };
    await s.execute(command("untrusted-reply"));
    await s.clock.advance(15_000);
    expect(s.executor.getUsage()).toMatchObject([{ stoppedAt: null, stopLagMs: null }]);
    expect(await s.execute(command("blocked"))).toMatchObject({ status: "unavailable" });
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect(s.starts).toHaveLength(1);
  });
});
