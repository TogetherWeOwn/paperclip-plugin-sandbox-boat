import { describe, expect, it, vi } from "vitest";
import { OffloadBroker, type BackendCommand, type OffloadOutputSink } from "./broker.js";
import { ExecutorBackend, type ExecutorPort } from "./executor-backend.js";
import type { OffloadReadView } from "../offload-journal.js";
import { until } from "../test-support/offload-lifecycle-contract.js";

const command: BackendCommand = {
  commandId: "review-command", companyId: "company-a", runId: "run-a", cardId: "card-a",
  repoId: "repo-a", profileId: "rust-public", executionWorkspaceId: "workspace-a",
  cwdRelative: ".", argv: ["test", "--locked"], env: { CARGO_TERM_COLOR: "never" },
  queueTimeoutMs: 30_000, timeoutMs: 120_000,
};
const queued: OffloadReadView = { version: 1, commandId: command.commandId, state: "queued",
  remoteStarted: false, fallbackSafe: false, result: null, events: [], nextCursor: 0 };
const refused: OffloadReadView = { ...queued, state: "not_started", fallbackSafe: true };
const cancelled: OffloadReadView = { ...queued, state: "cancelled", remoteStarted: true,
  result: { exitCode: 130, signal: null, cancelled: true, timedOut: false,
    syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "staged-1" }, usageRecordId: null } };
function setup(now: () => number = Date.now) {
  let view = queued;
  const executor = {
    start: vi.fn<ExecutorPort["start"]>().mockResolvedValue(queued),
    readOutput: vi.fn<ExecutorPort["readOutput"]>().mockImplementation(async (_company, _run, _id, after = 0) => ({ ...view, nextCursor: after })),
    heartbeatCommand: vi.fn<ExecutorPort["heartbeatCommand"]>().mockResolvedValue(queued),
    cancelCommand: vi.fn<ExecutorPort["cancelCommand"]>().mockImplementation(async () => { view = cancelled; return cancelled; }),
  };
  const backend = new ExecutorBackend({ resolveExecutor: async () => executor, pollIntervalMs: 1 });
  const rows = new Map<string, unknown>();
  const store = { get: async (key: string) => structuredClone(rows.get(key) ?? null),
    set: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)); },
    delete: async (key: string) => { rows.delete(key); } };
  const broker = new OffloadBroker({ backend, store, now });
  const { companyId: _company, runId: _run, cardId: _card, repoId: _repo, profileId: _profile, ...payload } = command;
  const submit = () => broker.submit({ ...payload, version: 1, dryRun: false }, command);
  return { executor, backend, broker, store, submit, finish: () => { view = cancelled; } };
}

describe("executor bridge review regressions", () => {
  it("allows scoped cancellation of a live handle after a heartbeat enters unknown", async () => {
    const t = setup();
    try {
      await t.submit();
      await until(() => t.executor.readOutput.mock.calls.length > 0);
      t.executor.heartbeatCommand.mockRejectedValueOnce(new Error("temporary heartbeat failure"));
      expect((await t.broker.heartbeat(command.commandId, command)).body).toMatchObject({ state: "unknown", fallbackSafe: false });
      const response = await t.broker.cancel(command.commandId, command, "client");
      expect(t.executor.cancelCommand).toHaveBeenCalledExactlyOnceWith(command.companyId, command.runId, command.commandId, expect.any(String));
      expect(response.body).toMatchObject({ state: "cancelled", fallbackSafe: false, result: { syncBack: { artifactId: "staged-1" } } });
    } finally { t.finish(); }
  });

  it("still expires a live unknown handle instead of forgetting its cleanup deadline", async () => {
    let now = 1_000;
    const t = setup(() => now);
    try {
      await t.submit();
      t.executor.heartbeatCommand.mockRejectedValueOnce(new Error("temporary heartbeat failure"));
      await t.broker.heartbeat(command.commandId, command);
      await t.broker.read(command.commandId, command, 0);
      now += 30_001;
      await t.broker.checkExpirations();
      expect(t.executor.cancelCommand).toHaveBeenCalledTimes(1);
      expect((await t.broker.read(command.commandId, command, 0)).body).toMatchObject({ state: "cancelled", fallbackSafe: false });
    } finally { t.finish(); }
  });

  it("does not offer fallback or remint execution when a restarted broker has no live handle", async () => {
    const t = setup();
    try {
      await t.submit();
      await until(() => t.executor.readOutput.mock.calls.length > 0);
      // A fresh broker has only the shared journal, never the original handle.
      const restarted = new OffloadBroker({ store: t.store, backend: t.backend, now: Date.now });
      expect((await restarted.cancel(command.commandId, command, "client")).body)
        .toMatchObject({ state: "unknown", fallbackSafe: false });
      expect(t.executor.start).toHaveBeenCalledTimes(1);
      expect(t.executor.cancelCommand).not.toHaveBeenCalled();
    } finally { t.finish(); }
  });

  it("persists output produced during cancellation before publishing the settled receipt", async () => {
    const t = setup();
    const tail = { seq: 1, stream: "stderr" as const, dataBase64: Buffer.from("shutdown diagnostics\n").toString("base64") };
    let stopping = false;
    t.executor.cancelCommand.mockImplementation(async () => { stopping = true; t.finish(); return cancelled; });
    t.executor.readOutput.mockImplementation(async (_company, _run, _id, after = 0) => stopping
      ? { ...cancelled, events: after === 0 ? [tail] : [], nextCursor: Math.max(after, 1) }
      : { ...queued, nextCursor: after });
    try {
      await t.submit();
      await until(() => t.executor.readOutput.mock.calls.length > 0);
      const response = await t.broker.cancel(command.commandId, command, "client");
      expect(response.body).toMatchObject({ state: "cancelled", events: [{ stream: "stderr", dataBase64: tail.dataBase64 }],
        result: { syncBack: { artifactId: "staged-1" } } });
      const read = await t.broker.read(command.commandId, command, 0);
      expect(read.body).toMatchObject({ events: [{ stream: "stderr", dataBase64: tail.dataBase64 }] });
    } finally { t.finish(); }
  });

  it("does not accept never-started evidence after a starting acknowledgement", async () => {
    const t = setup();
    t.executor.start.mockResolvedValueOnce({ ...queued, state: "starting", remoteStarted: null });
    t.executor.readOutput.mockResolvedValueOnce(refused);
    const output = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), fail: vi.fn(), failToStart: vi.fn() } satisfies OffloadOutputSink;
    await t.backend.start(command, output).done;
    expect(output.failToStart).not.toHaveBeenCalled();
    expect(output.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "OFFLOAD_EXECUTION_UNKNOWN" }));
  });

  it("rejects a contradictory never-started acknowledgement without allowing replay", async () => {
    const t = setup();
    t.executor.start.mockResolvedValueOnce({ ...refused, remoteStarted: true });
    const output = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), fail: vi.fn(), failToStart: vi.fn() } satisfies OffloadOutputSink;
    await t.backend.start(command, output).done;
    expect(output.failToStart).not.toHaveBeenCalled();
    expect(output.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "OFFLOAD_EXECUTION_UNKNOWN" }));
  });

  it("honors an explicit start refusal even when admission allocated no journal row", async () => {
    const t = setup();
    t.executor.start.mockResolvedValueOnce(refused);
    t.executor.readOutput.mockRejectedValue(new Error("OFFLOAD_INVALID_REQUEST: no journal record"));
    const output = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), fail: vi.fn(), failToStart: vi.fn() } satisfies OffloadOutputSink;
    const handle = t.backend.start(command, output);
    await handle.done;
    expect(output.failToStart).toHaveBeenCalledTimes(1);
    expect(output.fail).not.toHaveBeenCalled();
    expect(t.executor.readOutput).not.toHaveBeenCalled();
    expect(t.executor.cancelCommand).not.toHaveBeenCalled();
    await expect(handle.cancel()).resolves.toMatchObject({ state: "not_started", fallbackSafe: true });
  });
});
