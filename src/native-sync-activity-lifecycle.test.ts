// Native sync must own activity independently of Execute. Scratch mutants
// remove ONLY sync's beginActivity/endActivity, leaving Execute unchanged.
import type { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const processes = vi.hoisted(() => ({ spawn: vi.fn(), actual: null as typeof spawn | null }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processes.actual = actual.spawn;
  return { ...actual, spawn: processes.spawn };
});
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { LocalSyncSsh, put, waitFor } from "./test-support/local-sync-ssh.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const MINUTE = 60_000;
const bytes = randomBytes(2 * 1024 * 1024);
let root: string;
let ssh: LocalSyncSsh;
let lease: PluginEnvironmentLease;
let boat: FakeBoat;
let clock: { t: number; now: () => number };
let harness: ReturnType<typeof createFakeContext>;
let config: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "sync-activity-"));
  ssh = new LocalSyncSsh(root, processes.actual!);
  processes.spawn.mockReset().mockImplementation(ssh.spawn);
  clock = { t: Date.parse("2026-10-23T00:00:00Z"), now: () => clock.t };
  boat = new FakeBoat(clock);
  setBoatApiFactoryForTests(() => boat as unknown as BoatApiLike);
  setManagerOverridesForTests({ ssh, now: clock.now, sleep: async () => {} });
  config = { apiKey: "boat_test_only", cliproxyTunnel: false, remoteWorkspaceDir: ssh.remoteRoot,
    idleStopMinutes: 15, staleLeaseMinutes: 60 };
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
  lease = await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config,
    runId: "sync-activity", executionWorkspaceId: WORKSPACE,
  });
  await currentManager().sweepInFlight();
});

afterEach(async () => {
  await ssh?.cleanup();
  await plugin.definition.onShutdown?.();
  setManagerOverridesForTests({});
  setBoatApiFactoryForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

for (const direction of ["in", "out"] as const) {
  for (const failure of [false, true]) {
    it(`${direction}: active payload survives actual stale sweep; ${failure ? "failure" : "success"} ends activity and becomes sweepable`, async () => {
      const hook = plugin.definition[direction === "in" ? "onEnvironmentSyncIn" : "onEnvironmentSyncOut"];
      expect(hook).toBeTypeOf("function");
      const source = path.join(root, direction === "in" ? "host" : "sandbox", "source");
      const target = path.join(root, direction === "in" ? "sandbox" : "host", "target");
      await put(source, bytes);
      await put(target, "old complete contents");
      const gate = ssh.armGate(direction, failure);
      const sandboxId = lease.providerLeaseId!;
      const oldDeadline = boat.boxes.get(sandboxId)!.archiveAfter!.getTime();
      clock.t += 70 * MINUTE; // crosses half the default 2-hour auto-stop TTL
      const transfer = hook!({ driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config, lease,
        operations: [{ operationId: "activity", files: [{
          sourcePath: ssh.remotePath(source), targetPath: ssh.remotePath(target), kind: "file",
        }] }],
      });
      let finished = false;
      let error: unknown;
      void transfer.then(() => { finished = true; }, (reason) => { error = reason; finished = true; });
      try {
        await waitFor(() => {
          if (error) throw error;
          if (existsSync(gate.reached)) return true;
          if (finished) throw new Error("sync finished before byte gate");
          return false;
        }, "native payload never reached real byte gate");
        expect(Number(await readFile(gate.reached, "utf8"))).toBeGreaterThanOrEqual(65536);
        expect(boat.callsOf("update").filter((call) => call.args.ttlSeconds != null)).toEqual([
          { method: "update", args: { sandboxId, ttlSeconds: 7200 } },
        ]);
        expect(boat.boxes.get(sandboxId)!.archiveAfter!.getTime()).toBe(clock.t + 7200_000);
        expect(boat.boxes.get(sandboxId)!.archiveAfter!.getTime()).toBeGreaterThan(oldDeadline);
        clock.t += 61 * MINUTE; // stale even relative to beginActivity
        const active = await currentManager().sweep("acceptance-active-sync", { force: true });
        expect.soft(active.stopped, "native sync, not Execute, must hold the VM active").toEqual([]);
        expect.soft(active.deleted).toEqual([]);
        expect.soft(active.errors).toEqual([]);
        expect.soft(boat.boxes.get(sandboxId)?.state).toBe("ready");
        expect.soft(boat.callsOf("stop")).toEqual([]);
        expect.soft(boat.callsOf("deleteSandbox")).toEqual([]);
      } finally { await ssh.releaseGate(); }
      if (failure) {
        await expect(transfer).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("old complete contents");
      } else {
        expect(await transfer).toEqual({ operations: [{ operationId: "activity", filesTransferred: 1, bytesTransferred: bytes.length }] });
        expect(await readFile(target)).toEqual(bytes);
      }
      // endActivity must refresh last activity, not merely decrement a counter.
      const justFinished = await currentManager().sweep("acceptance-sync-finished", { force: true });
      expect(justFinished.stopped).toEqual([]);
      expect(justFinished.deleted).toEqual([]);
      expect(justFinished.errors).toEqual([]);
      clock.t += 61 * MINUTE;
      // Keep the original lease held: release would stop it itself and conceal
      // a leaked inflight activity counter. This actual sweep proves cleanup.
      const idle = await currentManager().sweep("acceptance-sync-idle", { force: true });
      expect(idle.stopped, "settled native sync must not leak activity forever").toEqual([sandboxId]);
      expect(idle.deleted).toEqual([]);
      expect(idle.errors).toEqual([]);
      expect(boat.boxes.get(sandboxId)?.state).toBe("archived");
      const doc = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as {
        vms: Record<string, { sandboxId: string; status: string; activeRunIds: string[] }>;
      };
      expect(Object.values(doc.vms).find((vm) => vm.sandboxId === sandboxId)).toMatchObject({
        status: "stopped", activeRunIds: [],
      });
    }, 20000);
  }
}
