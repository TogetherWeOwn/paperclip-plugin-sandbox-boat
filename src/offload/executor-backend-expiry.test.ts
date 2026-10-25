import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OffloadBroker, type BackendCommand, type OffloadBackend, type OffloadBackendHandle,
  type OffloadJournalStore } from "./broker.js";
import { ExecutorBackend } from "./executor-backend.js";
import { command, deferred, fixture, until, type Fixture } from "../test-support/offload-lifecycle-contract.js";
import { createFakeContext, fakeInvocations, inHostInvocation } from "../test-support/harness.js";

const companyId = "company-a";
const cmd = (id: string): BackendCommand => ({
  ...command(id, { executionWorkspaceId: `workspace-${id}` }),
  cwdRelative: ".", env: {}, timeoutMs: 120_000, queueTimeoutMs: 0,
});
const request = (input: BackendCommand) => ({
  version: 1 as const, commandId: input.commandId, executionWorkspaceId: input.executionWorkspaceId,
  cwdRelative: input.cwdRelative, argv: input.argv, env: input.env,
  timeoutMs: input.timeoutMs, queueTimeoutMs: input.queueTimeoutMs, dryRun: false,
});

// Same explicit-company state binding as BoatVmManager.offloadStore. Unlike an
// unscoped Map, this host port rejects continuations of a finished invocation.
function hostStore() {
  const { ctx } = createFakeContext({ hostScopes: { proactiveCompanies: [companyId] } });
  const scope = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId,
    namespace: "boat-offload", stateKey });
  const errors: string[] = [];
  const writes: unknown[] = [];
  async function checked<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) { errors.push(String(error)); throw error; }
  }
  const store: OffloadJournalStore = {
    get: (key) => checked(() => ctx.state.get(scope(key))),
    set: (key, value) => checked(async () => {
      await ctx.state.set(scope(key), value);
      writes.push(structuredClone(value));
    }),
    delete: (key) => ctx.state.delete(scope(key)),
  };
  return { store, errors, writes };
}

let f: Fixture | undefined;
let handles: OffloadBackendHandle[] = [];
let releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases) release();
  await Promise.allSettled(handles.map((handle) => handle.done));
  await f?.dispose();
  vi.restoreAllMocks();
  f = undefined;
  handles = [];
  releases = [];
});

describe("detached expiry host invocation scope", () => {
  it("never starts an expired sync-in after cancellation I/O outlives the triggering heartbeat", async () => {
    const live = f = await fixture();
    const scoped = hostStore();
    const slow = cmd("expired-sync-in");
    const healthy = cmd("healthy");
    const push = live.hold(`push:${slow.commandId}`);
    const exec = live.hold(`exec:${healthy.commandId}`);
    const cancellationIO = deferred<void>();
    releases.push(() => push.resolve(), () => exec.resolve(), () => cancellationIO.resolve());
    const cancelling = new AsyncLocalStorage<boolean>();
    let cancellationReadHeld = false;
    // Retain the real file-backed journal/pool/ledger. Apply the same host
    // permission boundary before every read/write, including cancellation.
    const diskGet = live.state.get.bind(live.state);
    const diskSet = live.state.set.bind(live.state);
    vi.spyOn(live.state, "get").mockImplementation(async (key) => {
      if (!cancellationReadHeld && cancelling.getStore() && key.namespace === "guest-test-journal") {
        cancellationReadHeld = true;
        await cancellationIO.promise;
      }
      await scoped.store.get(key.stateKey);
      return diskGet(key);
    });
    vi.spyOn(live.state, "set").mockImplementation(async (key, value) => {
      await scoped.store.set(key.stateKey, value);
      await diskSet(key, value);
    });
    const executor = live.make({ maxOffloadVms: 2 });
    const cancel = executor.cancelCommand.bind(executor);
    vi.spyOn(executor, "cancelCommand").mockImplementation((...args) =>
      cancelling.run(true, () => cancel(...args)));
    const adapter = new ExecutorBackend({ resolveExecutor: async () => executor, pollIntervalMs: 1 });
    const backend: OffloadBackend = { start: (input, sink) => {
      const handle = adapter.start(input, sink);
      handles.push(handle);
      return handle;
    } };
    const broker = new OffloadBroker({ store: scoped.store, backend, now: live.clock.now });
    await inHostInvocation(companyId, () => broker.submit(request(slow), slow));
    await until(() => live.trace.includes(`push:${slow.commandId}`));
    await inHostInvocation(companyId, () => broker.submit(request(healthy), healthy));
    await until(() => live.guest.alive(healthy.commandId));
    await live.clock.advance(25_000);
    await inHostInvocation(companyId, () => broker.heartbeat(healthy.commandId, healthy));
    await live.clock.advance(6_000);
    const invocation = await inHostInvocation(companyId, async () => {
      const current = fakeInvocations.getStore()!;
      expect((await broker.heartbeat(healthy.commandId, healthy)).body).toMatchObject({ state: "running" });
      return current;
    });
    await until(() => cancellationReadHeld);
    expect(invocation.ended).toBe(true);
    // Only now let the cancellation journal read reach the host permission check.
    cancellationIO.resolve();
    await until(() => scoped.errors.length > 0 || live.state.writes.some((raw) => {
      const row = raw as { commandId?: string; cancelRequested?: string };
      return row.commandId === slow.commandId && row.cancelRequested === "broker_cancel";
    }));
    push.resolve();
    await handles[0]!.done;
    const receipt = await inHostInvocation(companyId, () => broker.read(slow.commandId, slow, 0));
    expect(live.starts.map((start) => start.commandId)).toEqual([healthy.commandId]);
    expect(receipt.body).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect(scoped.errors).toEqual([]);
    expect(live.guest.alive(healthy.commandId)).toBe(true);
  });

  it("persists the detached cancellation receipt after the heartbeat invocation ends", async () => {
    const scoped = hostStore();
    const slow = cmd("expired-receipt");
    const healthy = cmd("healthy");
    const cancellationIO = deferred<void>();
    releases.push(() => cancellationIO.resolve());
    const cancel = vi.fn(async () => {
      await cancellationIO.promise;
      return { state: "cancelled" as const, remoteStarted: true as const, fallbackSafe: false as const,
        result: { exitCode: 130, signal: null, timedOut: false, cancelled: true,
          syncBack: { state: "clean" as const, changedPaths: [], conflictPaths: [], artifactId: null } } };
    });
    let now = 0;
    // No terminal sink callback: only cancelCommand's final journal update can
    // persist this authoritative receipt. Scoping just the adapter is not enough.
    const backend: OffloadBackend = { start: () => ({ done: Promise.resolve(), cancel }) };
    const broker = new OffloadBroker({ store: scoped.store, backend, now: () => now });
    await inHostInvocation(companyId, () => broker.submit(request(slow), slow));
    await inHostInvocation(companyId, () => broker.submit(request(healthy), healthy));
    now = 25_000;
    await inHostInvocation(companyId, () => broker.heartbeat(healthy.commandId, healthy));
    now = 31_000;
    const invocation = await inHostInvocation(companyId, async () => {
      const current = fakeInvocations.getStore()!;
      await broker.heartbeat(healthy.commandId, healthy);
      return current;
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(invocation.ended).toBe(true);
    cancellationIO.resolve();
    await until(() => scoped.errors.length > 0 || scoped.writes.some((raw) => {
      const row = raw as { commandId?: string; state?: string };
      return row.commandId === slow.commandId && row.state === "cancelled";
    }));
    const receipt = await inHostInvocation(companyId, () => broker.read(slow.commandId, slow, 0));
    expect(receipt.body).toMatchObject({ state: "cancelled", remoteStarted: true, fallbackSafe: false,
      result: { exitCode: 130, cancelled: true } });
    expect(scoped.errors).toEqual([]);
  });
});
