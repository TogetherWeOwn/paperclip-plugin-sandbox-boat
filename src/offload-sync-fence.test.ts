import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffloadExecutor } from "./offload.js";
import type { OffloadCommand, OffloadLifecycleDeps } from "./offload.js";
import type { BoatApiLike } from "./boat-client.js";
import { command, completed, deferred, DiskState, fixture, until } from "./test-support/offload-lifecycle-contract.js";
import type { Fixture, LifecycleCommand, RunContext } from "./test-support/offload-lifecycle-contract.js";

// Breaks caught: a sync installer/receiver living outside the previous command
// cgroup being trusted because that old cgroup observes empty; the durable
// syncInFlight flag being written after (not before) guest sync work; clearing
// the flag on a merely accepted stop; sandboxStopped firing without a provider
// terminal state; a fenced VM being reused (or its slot leaked) after recovery.
let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

type PushHook = (sandboxId: string, cmd: LifecycleCommand) => Promise<void>;

// The shared fixture hard-wires its sync port, so build the executor here from
// the same fixture clock/boat/guest/disk with an instrumented sync port.
function build(pushHook: PushHook, stopped: string[], disk = s.state, maxOffloadVms = 1) {
  const deps = {
    boat: s.boat as unknown as BoatApiLike,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: s.clock.now, timers: { set: s.clock.set, clear: s.clock.clear },
    config: { maxOffloadVms, offloadIdleStopSeconds: 15 },
    state: disk, accountId: `guest-test:${s.root}`, poolId: "guest-test-pool", guest: s.guest,
    journalStore: disk.store(),
    guestReceipts: { bootId: async () => "boot-a", read: async () => null },
    resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: Date.parse("2026-10-23T10:00:00Z") + 86_400_000 }),
    sync: {
      push: (sandboxId: string, cmd: OffloadCommand) => pushHook(sandboxId, cmd as LifecycleCommand),
      sandboxStopped: (sandboxId: string) => { stopped.push(sandboxId); },
      collect: async () => ({ changedPaths: [], files: [] }),
      stage: async (_vm: string, cmd: OffloadCommand) => ({ state: "staged" as const, changedPaths: [], conflictPaths: [], artifactId: `artifact-${cmd.commandId}` }),
      markSuspect: async () => {},
    },
    runCommand: (async (sandboxId: string, raw: OffloadCommand, context?: RunContext) => {
      const cmd = raw as LifecycleCommand;
      s.starts.push({ sandboxId, commandId: cmd.commandId, context, persisted: undefined });
      s.guest.spawn(cmd, context);
      s.guest.exit(cmd.commandId);
      return completed();
    }) as OffloadLifecycleDeps["runCommand"],
  };
  const executor = new OffloadExecutor(deps as unknown as ConstructorParameters<typeof OffloadExecutor>[0]);
  return executor;
}

async function persistedVms(disk: DiskState): Promise<Array<{ sandboxId: string; syncInFlight?: boolean; quarantined: boolean; stopped: boolean }>> {
  const doc = await disk.all();
  for (const [key, value] of Object.entries(doc)) {
    if ((JSON.parse(key) as { namespace: string }).namespace === "boat-offload-pool") return (value as { vms: never[] }).vms;
  }
  return [];
}
const flagOnDisk = async (id: string) => (await persistedVms(new DiskState(s.state.path))).find((v) => v.sandboxId === id)?.syncInFlight;
const api = (ex: OffloadExecutor) => ex as unknown as { recover(): Promise<unknown>; sweep(): Promise<unknown> };

describe("offload sync fence: durable syncInFlight", () => {
  it("is persisted before sync work and cleared after a successful push", async () => {
    const seen: Array<boolean | undefined> = [];
    const ex = build(async (id) => { seen.push(await flagOnDisk(id)); }, []);
    await s.execute(command("c1"), ex);
    const id = s.starts[0]!.sandboxId;
    expect(seen).toEqual([true]);
    expect(await flagOnDisk(id)).toBeFalsy();
  });

  it("failed second sync after a successful command stays fenced across a failed stop and a new executor; old empty cgroup never enables reuse", async () => {
    const stopped: string[] = [];
    let n = 0;
    const seen: Array<boolean | undefined> = [];
    const first = build(async (id) => {
      n += 1;
      seen.push(await flagOnDisk(id));
      if (n === 2) throw new Error("installer died midway; receiver may live");
    }, stopped);
    await s.execute(command("c1"), first);
    const id = s.starts[0]!.sandboxId;
    expect(await flagOnDisk(id)).toBeFalsy();
    // Same VM, previous command's identity is recorded and its cgroup is empty.
    s.boat.stopMode = "stays_up";
    s.boat.failNext("stop", new Error("lost stop reply"));
    await s.execute(command("c2"), first);
    expect(seen).toEqual([true, true]);
    expect(s.starts.map((v) => v.commandId)).toEqual(["c1"]);
    expect(await flagOnDisk(id)).toBe(true);
    expect(s.boat.callsOf("stop").length).toBeGreaterThanOrEqual(1);
    expect(stopped).toEqual([]);

    // New worker reloads only the disk document.
    s.clock.crashWorker();
    const second = build(async () => { throw new Error("must not sync into a fenced VM"); }, stopped);
    await api(second).recover();
    await api(second).sweep();
    const vm = (await persistedVms(new DiskState(s.state.path))).find((v) => v.sandboxId === id)!;
    expect(vm).toMatchObject({ syncInFlight: true, quarantined: true });
    // Accepted stop (provider still up) is not a terminal proof.
    expect(s.boat.callsOf("stop").length).toBeGreaterThanOrEqual(2);
    expect(stopped).toEqual([]);
    // Old command observed empty, yet the VM must not take a new command.
    const refused = await s.execute(command("c3"), second);
    expect(refused).toMatchObject({ status: "unavailable" });
    expect(s.starts.map((v) => v.commandId)).toEqual(["c1"]);
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(await flagOnDisk(id)).toBe(true);
  });

  it("orders a delayed second-VM admission save before the sync fence and preserves it on recovery", async () => {
    const warmGate = deferred<void>();
    const syncGate = deferred<void>();
    const journalGate = deferred<void>();
    const oldSaveGate = deferred<void>();
    const pushes: string[] = [];
    const stopped: string[] = [];
    const first = build(async (_id, cmd) => {
      pushes.push(cmd.commandId);
      if (cmd.commandId === "warm-a") await warmGate.promise;
      if (cmd.commandId.startsWith("next-")) await syncGate.promise;
    }, stopped, s.state, 2);
    const warmA = s.execute(command("warm-a"), first);
    await until(() => pushes.includes("warm-a"));
    await s.execute(command("warm-b", { executionWorkspaceId: "workspace-b" }), first);
    warmGate.resolve();
    await warmA;
    const idA = s.starts.find((v) => v.commandId === "warm-a")!.sandboxId;
    const idB = s.starts.find((v) => v.commandId === "warm-b")!.sandboxId;
    expect(idA).not.toBe(idB);
    expect(s.boat.callsOf("create")).toHaveLength(2);

    const set = s.state.set.bind(s.state);
    let journalHeld = false;
    let oldSaveHeld = false;
    let fenceRequested = false;
    type Snapshot = { vms: Array<{ sandboxId: string; busy: boolean; syncInFlight?: boolean; identity: { commandId: string } | null }> };
    vi.spyOn(s.state, "set").mockImplementation(async (key, value) => {
      const record = value as { commandId?: string; state?: string };
      if (key.namespace === "guest-test-journal" && record.commandId === "next-a" && record.state === "syncing_in") {
        journalHeld = true;
        await journalGate.promise;
      }
      if (key.namespace === "boat-offload-pool") {
        const vms = (value as Snapshot).vms;
        const a = vms.find((vm) => vm.sandboxId === idA)!;
        const b = vms.find((vm) => vm.sandboxId === idB)!;
        if (!oldSaveHeld && a.busy && !a.syncInFlight && b.busy) {
          expect(a.identity?.commandId).toBe("warm-a");
          oldSaveHeld = true;
          await oldSaveGate.promise; // backend would allow a later set to commit first
        }
      }
      await set(key, value);
    });
    // Observe invocation of the fence save, even when its state.set is queued.
    const store = (first as unknown as { poolStore: { save: (...args: unknown[]) => Promise<void> } }).poolStore;
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation((...args) => {
      const vms = args[1] as Snapshot["vms"];
      if (vms.find((vm) => vm.sandboxId === idA)?.syncInFlight) fenceRequested = true;
      return save(...args);
    });
    const nextA = s.execute(command("next-a"), first);
    let nextB: ReturnType<typeof s.execute> | undefined;
    try {
      await until(() => journalHeld);
      nextB = s.execute(command("next-b", { executionWorkspaceId: "workspace-b" }), first);
      await until(() => oldSaveHeld);
      journalGate.resolve();
      await until(() => fenceRequested);
      // The old save must complete before a fence authorizes guest mutation.
      expect(pushes).not.toContain("next-a");
      oldSaveGate.resolve();
      await until(() => pushes.includes("next-a") && pushes.includes("next-b"));
      expect(await flagOnDisk(idA)).toBe(true);
      const beforeCrash = await persistedVms(new DiskState(s.state.path));
      expect(beforeCrash).toHaveLength(2);
      expect(beforeCrash.every((vm) => vm.syncInFlight)).toBe(true);

      // Both installers are suspended outside their previous empty cgroups.
      // A new executor reads disk only; accepted-but-running stops prove nothing.
      s.clock.crashWorker();
      s.boat.stopMode = "stays_up";
      const recoveredPushes: string[] = [];
      const second = build(async (id) => { recoveredPushes.push(id); }, stopped, new DiskState(s.state.path), 2);
      await api(second).recover();
      await api(second).sweep();
      const recovered = await persistedVms(new DiskState(s.state.path));
      expect(recovered).toHaveLength(2);
      for (const vm of recovered) expect(vm).toMatchObject({ syncInFlight: true, quarantined: true });
      expect(s.boat.callsOf("stop").map((v) => v.args.sandboxId)).toEqual(expect.arrayContaining([idA, idB]));
      expect(await s.execute(command("probe-a"), second)).toMatchObject({ status: "unavailable" });
      expect(await s.execute(command("probe-b", { executionWorkspaceId: "workspace-b" }), second)).toMatchObject({ status: "unavailable" });
      expect(recoveredPushes).toEqual([]);
      expect(stopped).toEqual([]);
      expect(s.starts.map((v) => v.commandId).sort()).toEqual(["warm-a", "warm-b"]);
    } finally {
      journalGate.resolve();
      oldSaveGate.resolve();
      // Settle abandoned callers only after recovery evidence has been inspected.
      syncGate.reject(new Error("abandoned worker"));
      await Promise.allSettled([nextA, ...(nextB ? [nextB] : [])]);
      vi.restoreAllMocks();
    }
  });

  it("requests stop despite a failed quarantined-release pool save and retains the durable fence", async () => {
    const stopped: string[] = [];
    let n = 0;
    let failedRelease = false;
    const set = s.state.set.bind(s.state);
    const first = build(async () => {
      n += 1;
      if (n === 2) {
        vi.spyOn(s.state, "set").mockImplementation(async (key, value) => {
          if (key.namespace === "boat-offload-pool" && (value as { vms: Array<{ busy: boolean; syncInFlight?: boolean }> }).vms
            .some((vm) => !vm.busy && vm.syncInFlight) && !failedRelease) {
            failedRelease = true;
            throw new Error("release persistence unavailable");
          }
          await set(key, value);
        });
        throw new Error("installer outcome unknown");
      }
    }, stopped);
    try {
      await s.execute(command("c1"), first);
      const id = s.starts[0]!.sandboxId;
      s.boat.stopMode = "stays_up";
      await s.execute(command("c2"), first);
      expect(failedRelease).toBe(true);
      expect(s.boat.callsOf("stop").map((v) => v.args.sandboxId)).toContain(id);
      expect(await flagOnDisk(id)).toBe(true);
      expect(stopped).toEqual([]);
      expect(s.starts.map((v) => v.commandId)).toEqual(["c1"]);
    } finally { vi.restoreAllMocks(); }
  });

  it("provider-proven terminal recovery clears the flag and resumes the same sandbox under maxOffloadVms 1", async () => {
    const stopped: string[] = [];
    let n = 0;
    const first = build(async () => { n += 1; if (n === 2) throw new Error("sync failed"); }, stopped);
    await s.execute(command("c1"), first);
    const id = s.starts[0]!.sandboxId;
    s.boat.stopMode = "stays_up";
    await s.execute(command("c2"), first);
    expect(await flagOnDisk(id)).toBe(true);
    expect(stopped).toEqual([]);

    s.clock.crashWorker();
    s.boat.boxes.get(id)!.state = "archived"; // provider-confirmed terminal
    const second = build(async () => {}, stopped);
    await api(second).recover();
    await api(second).sweep();
    expect(stopped).toContain(id);
    expect(await flagOnDisk(id)).toBeFalsy();
    const resumesBefore = s.boat.callsOf("resume").length;
    const next = await s.execute(command("c4"), second);
    expect(next).toMatchObject({ status: "completed" });
    expect(s.starts.at(-1)).toMatchObject({ commandId: "c4", sandboxId: id });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("resume").length).toBeGreaterThan(resumesBefore);
  });

  it("interrupted sync with no failure result persisted is fenced by recovery and only a terminal state unfences it", async () => {
    const stopped: string[] = [];
    const gate = deferred<void>();
    let syncing = false;
    const first = build(async () => { syncing = true; await gate.promise; }, stopped);
    const pending = s.execute(command("hang"), first);
    await until(() => syncing);
    const id = (await persistedVms(new DiskState(s.state.path))).find((v) => v.syncInFlight)!.sandboxId;
    s.clock.crashWorker();
    s.boat.stopMode = "stays_up";
    const second = build(async () => {}, stopped);
    await api(second).recover();
    await api(second).sweep();
    expect(s.boat.callsOf("stop").map((v) => v.args.sandboxId)).toContain(id);
    expect(stopped).toEqual([]);
    expect(await flagOnDisk(id)).toBe(true);
    expect(await s.execute(command("probe"), second)).toMatchObject({ status: "unavailable" });
    expect(s.starts).toEqual([]);

    s.boat.boxes.get(id)!.state = "archived";
    await api(second).sweep();
    expect(stopped).toContain(id);
    expect(await flagOnDisk(id)).toBeFalsy();
    // Do not let the abandoned first executor persist over the disk.
    gate.reject(new Error("abandoned"));
    await pending.catch(() => undefined);
  });

  it.each(["archived", "cancelled"])("terminal %s clears the flag after settlement and reports the verified stop", async (terminal) => {
    const stopped: string[] = [];
    let n = 0;
    const first = build(async () => { n += 1; if (n === 2) throw new Error("sync failed"); }, stopped);
    await s.execute(command("c1"), first);
    const id = s.starts[0]!.sandboxId;
    s.boat.stopMode = "stays_up";
    await s.execute(command("c2"), first);
    s.clock.crashWorker();
    s.boat.boxes.get(id)!.state = terminal;
    const second = build(async () => {}, stopped);
    await api(second).recover();
    await api(second).sweep();
    await api(second).sweep();
    expect(stopped.filter((v) => v === id).length).toBeGreaterThanOrEqual(1);
    expect(await flagOnDisk(id)).toBeFalsy();
    expect((await persistedVms(new DiskState(s.state.path))).find((v) => v.sandboxId === id)).toMatchObject({ quarantined: false, stopped: true });
  });

  it("a deleted sandbox reports sandboxStopped and leaves the pool", async () => {
    const stopped: string[] = [];
    let n = 0;
    const first = build(async () => { n += 1; if (n === 2) throw new Error("sync failed"); }, stopped);
    await s.execute(command("c1"), first);
    const id = s.starts[0]!.sandboxId;
    s.boat.stopMode = "stays_up";
    await s.execute(command("c2"), first);
    s.clock.crashWorker();
    s.boat.boxes.delete(id);
    const second = build(async () => {}, stopped);
    await api(second).recover();
    await api(second).sweep();
    expect(stopped).toContain(id);
    expect((await persistedVms(new DiskState(s.state.path))).some((v) => v.sandboxId === id)).toBe(false);
  });
});
