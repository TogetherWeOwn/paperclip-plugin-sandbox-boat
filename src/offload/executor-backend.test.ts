import { afterEach, describe, expect, it, vi } from "vitest";
import { OffloadBroker, type BackendCommand, type OffloadJournalStore, type OffloadOutputSink } from "./broker.js";
import { ExecutorBackend, type ExecutorPort } from "./executor-backend.js";
import { fixture, command, until, type Fixture } from "../test-support/offload-lifecycle-contract.js";
import type { OffloadReadView } from "../offload-journal.js";

const cmd: BackendCommand = {
  ...command("adapter-command"), executionWorkspaceId: "workspace-a", cwdRelative: ".",
  env: { CARGO_TERM_COLOR: "never" }, queueTimeoutMs: 30_000, timeoutMs: 120_000,
};
const clean = { state: "clean" as const, changedPaths: [], conflictPaths: [], artifactId: null };
const queued: OffloadReadView = {
  version: 1, commandId: cmd.commandId, state: "queued", remoteStarted: false,
  fallbackSafe: false, events: [], nextCursor: 0, result: null,
};
const completed: OffloadReadView = {
  ...queued, state: "completed", remoteStarted: true,
  result: { exitCode: 23, signal: null, timedOut: false, cancelled: false, syncBack: clean, usageRecordId: null },
};
const neverStarted: OffloadReadView = { ...queued, state: "not_started", fallbackSafe: true };

function sink() {
  return { started: vi.fn(), write: vi.fn(), complete: vi.fn(), failToStart: vi.fn(), fail: vi.fn() } satisfies OffloadOutputSink;
}
function port() {
  return {
    start: vi.fn<ExecutorPort["start"]>().mockResolvedValue(queued),
    readOutput: vi.fn<ExecutorPort["readOutput"]>().mockResolvedValue(completed),
    heartbeatCommand: vi.fn<ExecutorPort["heartbeatCommand"]>().mockResolvedValue(queued),
    cancelCommand: vi.fn<ExecutorPort["cancelCommand"]>().mockResolvedValue(neverStarted),
  };
}
function backend(executor: ExecutorPort | null) {
  return new ExecutorBackend({ resolveExecutor: async () => executor, pollIntervalMs: 1 });
}

let f: Fixture | undefined;
afterEach(async () => { await f?.dispose(); f = undefined; });

describe("executor backend", () => {
  it("forwards a snapshot of the complete workspace-bound command", async () => {
    const executor = port();
    const input = structuredClone(cmd);
    const handle = backend(executor).start(input, sink());
    input.argv.push("--changed-after-start");
    input.env.CARGO_TERM_COLOR = "changed";
    await handle.done;
    expect(executor.start).toHaveBeenCalledExactlyOnceWith(cmd);
  });

  it("streams byte-exact output before exit and drains all terminal pages without duplicates", async () => {
    const executor = port();
    let view: OffloadReadView = { ...queued, state: "starting", remoteStarted: null };
    executor.readOutput.mockImplementation(async (_company, _run, _id, after = 0) => {
      if (after === 0) return { ...view, events: [{ seq: 1, stream: "stdout", dataBase64: "AP8=" }], nextCursor: 1 };
      if (after === 1 && view.state === "completed") return {
        ...view, events: [{ seq: 2, stream: "stderr", dataBase64: "dGFpbA==" }], nextCursor: 2,
      };
      return { ...view, nextCursor: after };
    });
    const output = sink();
    const handle = backend(executor).start(cmd, output);
    await until(() => output.write.mock.calls.length === 1);
    expect(output.write).toHaveBeenCalledWith("stdout", Buffer.from([0, 255]));
    expect(output.started).toHaveBeenCalledTimes(1);
    expect(output.complete).not.toHaveBeenCalled();
    view = completed;
    await handle.done;
    expect(output.write.mock.calls).toEqual([["stdout", Buffer.from([0, 255])], ["stderr", Buffer.from("tail")]]);
    expect(output.complete).toHaveBeenCalledExactlyOnceWith(completed.result);
    expect(output.failToStart).not.toHaveBeenCalled();
  });

  it("maps only an explicit never-started receipt to safe fallback", async () => {
    const executor = port();
    executor.readOutput.mockResolvedValue(neverStarted);
    const output = sink();
    await backend(executor).start(cmd, output).done;
    expect(output.failToStart).toHaveBeenCalledTimes(1);
    expect(output.started).not.toHaveBeenCalled();
    expect(output.complete).not.toHaveBeenCalled();
    expect(output.fail).not.toHaveBeenCalled();
  });

  it("refuses an absent executor without any remote effect", async () => {
    const output = sink();
    await backend(null).start(cmd, output).done;
    expect(output.failToStart).toHaveBeenCalledTimes(1);
    expect(output.fail).not.toHaveBeenCalled();
  });

  it("treats a rejected start as ambiguous, not a fallback receipt", async () => {
    const executor = port();
    executor.start.mockRejectedValue(new Error("lost acknowledgement"));
    const output = sink();
    await backend(executor).start(cmd, output).done;
    expect(output.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "OFFLOAD_EXECUTION_UNKNOWN" }));
    expect(output.failToStart).not.toHaveBeenCalled();
  });

  it.each(["unknown", "failed"] as const)("holds a %s receipt without local replay", async (state) => {
    const executor = port();
    executor.readOutput.mockResolvedValue({ ...queued, state, remoteStarted: null });
    const output = sink();
    await backend(executor).start(cmd, output).done;
    expect(output.fail).toHaveBeenCalledTimes(1);
    expect(output.failToStart).not.toHaveBeenCalled();
  });

  it("does not trust contradictory never-started evidence", async () => {
    const executor = port();
    executor.readOutput.mockResolvedValue({ ...neverStarted, remoteStarted: true });
    const output = sink();
    await backend(executor).start(cmd, output).done;
    expect(output.failToStart).not.toHaveBeenCalled();
    expect(output.fail).toHaveBeenCalledTimes(1);
  });

  it("attempts scoped cleanup on output transport failure and never enables fallback", async () => {
    const executor = port();
    executor.readOutput.mockRejectedValue(new Error("connection lost"));
    const output = sink();
    await backend(executor).start(cmd, output).done;
    expect(executor.cancelCommand).toHaveBeenCalledWith(cmd.companyId, cmd.runId, cmd.commandId, expect.any(String));
    expect(output.fail).toHaveBeenCalledTimes(1);
    expect(output.failToStart).not.toHaveBeenCalled();
  });

  it("forwards client interest to the scoped lifecycle heartbeat", async () => {
    const executor = port();
    let view = queued;
    executor.readOutput.mockImplementation(async () => view);
    const handle = backend(executor).start(cmd, sink());
    await handle.heartbeat!();
    expect(executor.heartbeatCommand).toHaveBeenCalledExactlyOnceWith(cmd.companyId, cmd.runId, cmd.commandId);
    view = completed;
    await handle.done;
  });

  it("cancel waits for start admission and preserves the actual terminal receipt", async () => {
    const executor = port();
    let admit!: (value: OffloadReadView) => void;
    executor.start.mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
    let view = queued;
    executor.readOutput.mockImplementation(async () => view);
    executor.cancelCommand.mockImplementation(async () => { view = neverStarted; return view; });
    const handle = backend(executor).start(cmd, sink());
    const cancelled = handle.cancel();
    await until(() => executor.start.mock.calls.length === 1);
    expect(executor.cancelCommand).not.toHaveBeenCalled();
    admit(queued);
    await expect(cancelled).resolves.toEqual({ state: "not_started", remoteStarted: false, fallbackSafe: true, result: null });
    await handle.done;
  });

  it("cancel joins actual guest subtree cleanup and preserves staged return", async () => {
    f = await fixture();
    f.hold(`exec:${cmd.commandId}`);
    f.descendants();
    const output = sink();
    const handle = backend(f.executor).start(cmd, output);
    await until(() => f!.guest.alive(cmd.commandId));
    const cancelled = handle.cancel();
    await until(() => f!.guest.actions.some((a) => a.kind === "term"));
    expect(f.guest.alive(cmd.commandId)).toBe(true);
    await f.clock.advance(5_000);
    const receipt = await cancelled;
    expect(f.guest.alive(cmd.commandId)).toBe(false);
    expect(f.guest.actions.some((a) => a.kind === "kill")).toBe(true);
    expect(receipt).toMatchObject({ state: "cancelled", remoteStarted: true, fallbackSafe: false,
      result: { cancelled: true, syncBack: { state: "staged", artifactId: `artifact-${cmd.commandId}` } } });
    expect(output.failToStart).not.toHaveBeenCalled();
  });

  it("maps an actual sync-in start failure to a durable never-started fallback", async () => {
    f = await fixture();
    f.fail.add(`push:${cmd.commandId}`);
    const output = sink();
    await backend(f.executor).start(cmd, output).done;
    expect(output.failToStart).toHaveBeenCalledTimes(1);
    expect(f.starts).toHaveLength(0);
    expect(output.fail).not.toHaveBeenCalled();
  });

  it("does not grant local fallback while a cancelled sync-in still reads the workspace", async () => {
    f = await fixture();
    const push = f.hold(`push:${cmd.commandId}`);
    const output = sink();
    const handle = backend(f.executor).start(cmd, output);
    await until(() => f!.trace.includes(`push:${cmd.commandId}`));
    let settled = false;
    const cancelled = handle.cancel().then((receipt) => { settled = true; return receipt; });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    expect(output.failToStart).not.toHaveBeenCalled();
    push.resolve();
    await expect(cancelled).resolves.toMatchObject({ state: "not_started", fallbackSafe: true });
    expect(f.starts).toHaveLength(0);
  });

  it("rejects cancellation when guest cleanup cannot be verified", async () => {
    f = await fixture();
    f.hold(`exec:${cmd.commandId}`);
    const output = sink();
    const handle = backend(f.executor).start(cmd, output);
    await until(() => f!.guest.alive(cmd.commandId));
    f.guest.observable = false;
    await expect(handle.cancel()).rejects.toThrow();
    expect(output.failToStart).not.toHaveBeenCalled();
    f.guest.observable = true;
    // Fixture disposal releases the held runner, never a real VM.
  });
});

class Store implements OffloadJournalStore {
  rows = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.rows.get(key) ?? null); }
  async set(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
  async delete(key: string) { this.rows.delete(key); }
}
function brokerFor(executor: ExecutorPort) {
  return new OffloadBroker({ store: new Store(), backend: backend(executor), now: Date.now });
}
const request = { version: 1 as const, commandId: cmd.commandId, executionWorkspaceId: "workspace-a",
  cwdRelative: cmd.cwdRelative, argv: cmd.argv, env: cmd.env,
  queueTimeoutMs: cmd.queueTimeoutMs, timeoutMs: cmd.timeoutMs, dryRun: false };

describe("broker with real executor adapter", () => {
  it("forwards broker heartbeats to guest interest without the output pump renewing it", async () => {
    const executor = port();
    let view = queued;
    executor.readOutput.mockImplementation(async () => view);
    const broker = brokerFor(executor);
    await broker.submit(request, cmd);
    await until(() => executor.readOutput.mock.calls.length > 0);
    expect(executor.heartbeatCommand).not.toHaveBeenCalled();
    await broker.heartbeat(cmd.commandId, cmd);
    expect(executor.heartbeatCommand).toHaveBeenCalledExactlyOnceWith(cmd.companyId, cmd.runId, cmd.commandId);
    view = completed;
    await expect.poll(async () => (await broker.read(cmd.commandId, cmd, 0)).body).toMatchObject({ state: "completed" });
  });

  it("does not turn a failed heartbeat into fallback permission", async () => {
    const executor = port();
    let view = queued;
    executor.readOutput.mockImplementation(async () => view);
    executor.heartbeatCommand.mockRejectedValue(new Error("interest renewal unobservable"));
    const broker = brokerFor(executor);
    await broker.submit(request, cmd);
    expect((await broker.heartbeat(cmd.commandId, cmd)).body).toMatchObject({ state: "unknown", fallbackSafe: false });
    view = completed;
    await expect.poll(async () => (await broker.read(cmd.commandId, cmd, 0)).body).toMatchObject({ state: "completed" });
  });

  it("persists uncertain start as an unknown hold, not never-started", async () => {
    const executor = port();
    executor.start.mockRejectedValue(new Error("lost start reply"));
    const broker = brokerFor(executor);
    await broker.submit(request, cmd);
    await expect.poll(async () => (await broker.read(cmd.commandId, cmd, 0)).body)
      .toMatchObject({ state: "unknown", fallbackSafe: false });
    expect(executor.start).toHaveBeenCalledTimes(1);
  });

  it("uses cancellation evidence even when the broker has not seen a start callback", async () => {
    const executor = port();
    let view = queued;
    executor.readOutput.mockImplementation(async () => view);
    executor.cancelCommand.mockImplementation(async () => {
      view = { ...completed, state: "cancelled", result: { ...completed.result!, cancelled: true,
        syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "staged-1" } } };
      return view;
    });
    const broker = brokerFor(executor);
    await broker.submit(request, cmd);
    const cancelled = await broker.cancel(cmd.commandId, cmd, "client");
    expect(cancelled.body).toMatchObject({ state: "cancelled", remoteStarted: true, fallbackSafe: false,
      result: { exitCode: 23, cancelled: true, syncBack: { state: "staged", artifactId: "staged-1" } } });
  });
});
