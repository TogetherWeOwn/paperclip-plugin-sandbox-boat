import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffloadBroker, type BackendCommand, type OffloadBackendHandle } from "./broker.js";
import { ExecutorBackend } from "./executor-backend.js";
import { runOffload, type ClientDeps, type HttpResult } from "./client.js";
import { OFFLOAD_BOUNDS, type OffloadReadResponse } from "./protocol.js";
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

describe("executor-to-broker-to-shim terminal output", () => {
  it.each(["accepted", "duplicate", "ambiguous"] as const)("drains completed output across broker pages after an %s submit", async (mode) => {
    const { broker, cmd, submit } = bridge();
    const input = cmd("paged-output", "workspace-output");
    // With the smaller broker page bound below, ambiguous submit needs more
    // than ten seconds of recovery sleeps. It must hand off to immediate drain.
    const stdout = Buffer.alloc(mode === "ambiguous" ? 819_200 : 102_400);
    for (let n = 0; n < stdout.length; n += 1) stdout[n] = n % 256;
    const stderr = Buffer.alloc(7000, 0xfe);
    f.output([["stdout", stdout], ["stderr", stderr]]);
    const accepted = await submit(input);
    await handles[0]!.done;
    expect((await broker.read(input.commandId, input, 0)).body).toMatchObject({ state: "completed" });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const reads: OffloadReadResponse[] = [];
    const local = vi.fn(async () => 99);
    const staged = vi.fn();
    const unknown = vi.fn();
    const sleep = vi.fn((ms: number) => f.clock.advance(ms));
    const startedAt = f.clock.now();
    const deps: ClientDeps = {
      now: f.clock.now, sleep,
      randomId: () => input.commandId, onSignal() {}, runLocal: local,
      stdout: (bytes) => { out.push(Buffer.from(bytes)); },
      stderr: (bytes) => { err.push(Buffer.from(bytes)); },
      reportStaged: staged, reportUnknown: unknown,
      http: {
        post: async (path): Promise<HttpResult> => {
          expect(path).toBe("/offload/exec");
          const response = mode === "accepted" ? accepted : await submit(input);
          if (mode === "ambiguous") return { ok: false, error: "lost submit acknowledgement" };
          return { ok: true, status: response.status, json: response.body };
        },
        get: async (path): Promise<HttpResult> => {
          const after = Number(new URL(path, "http://broker.invalid").searchParams.get("after"));
          const response = await broker.read(input.commandId, input, after,
            mode === "ambiguous" ? 32_768 : OFFLOAD_BOUNDS.readLimitBytes);
          reads.push(response.body as OffloadReadResponse);
          return { ok: true, status: response.status, json: response.body };
        },
      },
    };
    const exitCode = await runOffload({
      argv: input.argv, cwdRelative: input.cwdRelative, executionWorkspaceId: input.executionWorkspaceId,
      queueTimeoutMs: input.queueTimeoutMs, timeoutMs: input.timeoutMs, processEnv: {},
    }, deps);
    expect({ exitCode, stdoutBytes: Buffer.concat(out).length, stderrBytes: Buffer.concat(err).length,
      elapsedMs: f.clock.now() - startedAt }).toEqual({
      exitCode: 74, stdoutBytes: stdout.length, stderrBytes: stderr.length, elapsedMs: 0,
    }); // The real fixture returns a staged sync receipt, not unknown (75).
    expect(Buffer.concat(out)).toEqual(stdout);
    expect(Buffer.concat(err)).toEqual(stderr);
    expect(reads.length).toBeGreaterThan(1);
    if (mode === "ambiguous") {
      // At 500 ms per recovery retry, these pages outlast the recovery budget.
      expect(reads.length).toBeGreaterThan(OFFLOAD_BOUNDS.recoveryBudgetMs / 500 + 1);
    }
    expect(reads[0]?.state).toBe("completed");
    expect(reads.at(-1)?.events).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
    expect(staged).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ artifactId: `artifact-${input.commandId}` }));
    expect(local).not.toHaveBeenCalled();
    expect(handles).toHaveLength(1);
  });
});

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
