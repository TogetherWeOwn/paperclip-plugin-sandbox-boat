import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffloadBroker, type BackendCommand, type OffloadBackendHandle } from "./broker.js";
import { ExecutorBackend } from "./executor-backend.js";
import { command, fixture, until, type Fixture } from "../test-support/offload-lifecycle-contract.js";

let f: Fixture;
let handles: OffloadBackendHandle[];
let releases: Array<() => void>;
let pending: Promise<unknown>[];
beforeEach(async () => {
  f = await fixture();
  handles = [];
  releases = [];
  pending = [];
});
afterEach(async () => {
  for (const release of releases) release();
  await Promise.allSettled(pending);
  await Promise.allSettled(handles.map((handle) => handle.done));
  await f.dispose();
});
function hold(phase: string) {
  const gate = f.hold(phase);
  releases.push(() => gate.resolve());
  return gate;
}
function bridge() {
  const executor = f.make({ maxOffloadVms: 2 });
  const adapter = new ExecutorBackend({ resolveExecutor: async () => executor, pollIntervalMs: 1 });
  const rows = new Map<string, unknown>();
  const broker = new OffloadBroker({
    now: f.clock.now,
    store: {
      get: async (key) => structuredClone(rows.get(key) ?? null),
      set: async (key, value) => { rows.set(key, structuredClone(value)); },
      delete: async (key) => { rows.delete(key); },
    },
    backend: { start: (cmd, sink) => {
      const handle = adapter.start(cmd, sink);
      handles.push(handle);
      return handle;
    } },
  });
  const cmd = (id: string, workspace: string): BackendCommand => ({
    ...command(id, { executionWorkspaceId: workspace }), cwdRelative: ".",
    env: {}, timeoutMs: 120_000, queueTimeoutMs: 0,
  });
  const submit = (input: BackendCommand) => broker.submit({
    version: 1, commandId: input.commandId, executionWorkspaceId: input.executionWorkspaceId,
    cwdRelative: input.cwdRelative, argv: input.argv, env: input.env,
    timeoutMs: input.timeoutMs, queueTimeoutMs: input.queueTimeoutMs, dryRun: false,
  }, input);
  return { executor, broker, cmd, submit };
}

describe("executor-to-broker cancellation isolation", () => {
  it("renews a healthy guest while an unrelated expired sync-in is still settling", async () => {
    const { executor, broker, cmd, submit } = bridge();
    const slow = cmd("slow-sync", "workspace-slow");
    const healthy = cmd("healthy", "workspace-healthy");
    const push = hold(`push:${slow.commandId}`);
    hold(`exec:${healthy.commandId}`);
    const heartbeat = vi.spyOn(executor, "heartbeatCommand");
    const cancel = vi.spyOn(executor, "cancelCommand");
    await submit(slow);
    await until(() => f.trace.includes(`push:${slow.commandId}`));
    await submit(healthy);
    await until(() => f.guest.alive(healthy.commandId));
    await f.clock.advance(25_000);
    await broker.heartbeat(healthy.commandId, healthy);
    await f.clock.advance(6_000);
    let renewed = false;
    const next = broker.heartbeat(healthy.commandId, healthy).then((response) => { renewed = true; return response; });
    pending.push(next);
    await until(() => heartbeat.mock.calls.filter((call) => call[2] === healthy.commandId).length === 2);
    await until(() => renewed);
    expect((await next).body).toMatchObject({ state: "running" });
    expect(f.starts.map((start) => start.commandId)).toEqual([healthy.commandId]);
    expect((await broker.read(slow.commandId, slow, 0)).body).toMatchObject({ fallbackSafe: false });
    for (let n = 0; n < 2; n += 1) {
      await f.clock.advance(20_000);
      await broker.heartbeat(healthy.commandId, healthy);
      expect(f.guest.alive(healthy.commandId)).toBe(true);
    }
    // Repeated sweeps join one expiry task, not repeated per-command cancels.
    expect(cancel.mock.calls.filter((call) => call[2] === slow.commandId)).toHaveLength(1);
    push.resolve();
    await handles[0]!.done;
    await broker.checkExpirations();
    expect((await broker.read(slow.commandId, slow, 0)).body).toMatchObject({
      state: "not_started", remoteStarted: false, fallbackSafe: true,
    });
  });
});
