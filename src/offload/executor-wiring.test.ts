import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { currentManager, setManagerOverridesForTests } from "../plugin.js";
import manifest from "../manifest.js";
import { BoatVmManager } from "../vm-manager.js";
import { createFakeContext, inHostInvocation } from "../test-support/harness.js";
import type { ExecutorPort } from "./executor-backend.js";
import type { OffloadReadView } from "../offload-journal.js";
import { until } from "../test-support/offload-lifecycle-contract.js";
import { nativeWorkspaceParams } from "../test-support/native-workspace.js";

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const commandId = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const workspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const actor = { actorType: "agent" as const, actorId: "agent-a", agentId: "agent-a", runId };
const body = { version: 1, commandId, executionWorkspaceId: workspaceId, cwdRelative: ".",
  argv: ["test", "--locked"], env: { CARGO_TERM_COLOR: "never" }, queueTimeoutMs: 30_000, timeoutMs: 120_000, dryRun: false };
const terminal: OffloadReadView = { version: 1, commandId, state: "not_started", remoteStarted: false,
  fallbackSafe: true, result: null, events: [], nextCursor: 0 };
async function setup(config: Record<string, unknown> = {}) {
  const harness = createFakeContext();
  const executor: ExecutorPort = {
    start: vi.fn().mockResolvedValue(terminal), readOutput: vi.fn().mockResolvedValue(terminal),
    heartbeatCommand: vi.fn().mockResolvedValue(terminal), cancelCommand: vi.fn().mockResolvedValue(terminal),
  };
  const resolveExecutor = vi.fn<NonNullable<ConstructorParameters<typeof BoatVmManager>[0]["offloadExecutor"]>>(async () => executor);
  const readConfig = vi.fn(async () => config);
  const manager = new BoatVmManager({ state: harness.ctx.state, logger: harness.ctx.logger,
    offloadConfig: readConfig, offloadExecutor: resolveExecutor });
  await manager.rememberOffloadWorkspace(nativeWorkspaceParams(companyId, runId, workspaceId));
  return { manager, resolveExecutor, executor, harness, readConfig };
}
afterEach(async () => { await plugin.definition.onShutdown?.(); setManagerOverridesForTests({}); });

describe("executor opt-in wiring", () => {
  it("declares a default-OFF company plugin setting, independent of whole-run driver config", () => {
    expect(manifest.instanceConfigSchema).toMatchObject({ properties: { offloadExecutorEnabled: { type: "boolean", default: false } } });
  });

  it.each([undefined, false, "true", 1])("does not resolve or start an executor for flag %s", async (enabled) => {
    const t = await setup(enabled === undefined ? {} : { offloadExecutorEnabled: enabled });
    await t.manager.offloadExec(companyId, actor, body);
    // Company config is read at request time (profiles/threshold) and
    // re-read at dispatch; the dispatch re-check refuses here.
    await until(() => t.readConfig.mock.calls.length === 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.resolveExecutor).not.toHaveBeenCalled();
    const read = await t.manager.offloadRead(companyId, actor, { commandId }, {});
    expect(read.body).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    await t.manager.shutdown();
  });

  it("opts in only with true and forwards the authenticated workspace-bound payload", async () => {
    const t = await setup({ offloadExecutorEnabled: true });
    await t.manager.offloadExec(companyId, actor, body);
    await until(() => vi.mocked(t.executor.start).mock.calls.length === 1);
    expect(t.readConfig).toHaveBeenCalledWith(companyId);
    expect(t.executor.start).toHaveBeenCalledWith(expect.objectContaining({ companyId, runId,
      executionWorkspaceId: workspaceId, repoId: "repo:https://github.com/example/public-rust", profileId: "rust-public-1" }));
    await t.manager.shutdown();
  });

  it("refuses before dispatch when company config cannot be read", async () => {
    const t = await setup({ offloadExecutorEnabled: true });
    t.readConfig.mockRejectedValue(new Error("config unavailable"));
    await t.manager.offloadExec(companyId, actor, body);
    await expect.poll(async () => (await t.manager.offloadRead(companyId, actor, { commandId }, {})).body)
      .toMatchObject({ state: "not_started", fallbackSafe: true });
    expect(t.resolveExecutor).not.toHaveBeenCalled();
    await t.manager.shutdown();
  });

  it("keeps safe local fallback when opt-in has no installed lifecycle executor", async () => {
    const t = await setup({ offloadExecutorEnabled: true });
    t.resolveExecutor.mockResolvedValueOnce(null);
    await t.manager.offloadExec(companyId, actor, body);
    await until(() => t.resolveExecutor.mock.calls.length === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.executor.start).not.toHaveBeenCalled();
    expect((await t.manager.offloadRead(companyId, actor, { commandId }, {})).body).toMatchObject({ state: "not_started", fallbackSafe: true });
    await t.manager.shutdown();
  });

  it("re-reads config for new commands without dropping an earlier broker receipt", async () => {
    const config = { offloadExecutorEnabled: true };
    const t = await setup(config);
    await t.manager.offloadExec(companyId, actor, body);
    await until(() => vi.mocked(t.executor.start).mock.calls.length === 1);
    config.offloadExecutorEnabled = false;
    await t.manager.offloadExec(companyId, actor, { ...body, commandId: "00000000-0000-4000-8000-000000000002" });
    await until(() => t.readConfig.mock.calls.length === 4);
    expect(t.executor.start).toHaveBeenCalledTimes(1);
    expect((await t.manager.offloadRead(companyId, actor, { commandId }, {})).status).toBe(200);
    await t.manager.shutdown();
  });

  it("continues journaling after the submit invocation ends", async () => {
    const harness = createFakeContext({ hostScopes: { proactiveCompanies: [companyId] } });
    let finish!: (view: OffloadReadView) => void;
    const output = new Promise<OffloadReadView>((resolve) => { finish = resolve; });
    const executor: ExecutorPort = {
      start: async () => ({ ...terminal, state: "queued", fallbackSafe: false }),
      readOutput: async () => output,
      heartbeatCommand: async () => terminal, cancelCommand: async () => terminal,
    };
    const manager = new BoatVmManager({ state: harness.ctx.state, logger: harness.ctx.logger,
      offloadConfig: async () => ({ offloadExecutorEnabled: true }), offloadExecutor: async () => executor });
    await inHostInvocation(companyId, () => manager.rememberOffloadWorkspace(nativeWorkspaceParams(companyId, runId, workspaceId)));
    await inHostInvocation(companyId, () => manager.offloadExec(companyId, actor, body));
    finish(terminal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const read = await inHostInvocation(companyId, () => manager.offloadRead(companyId, actor, { commandId }, {}));
    expect(read.body).toMatchObject({ state: "not_started", fallbackSafe: true });
    await manager.shutdown();
  });

  it("uses the SDK company config port from plugin setup", async () => {
    const t = await setup();
    const get = vi.fn(async () => ({ offloadExecutorEnabled: true }));
    setManagerOverridesForTests({ offloadExecutor: t.resolveExecutor });
    await plugin.definition.setup({ ...t.harness.ctx, config: { get } } as never);
    await currentManager().startLocalRun(companyId, runId, "issue-a", "agent-a");
    await plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId, actor, body, params: {}, query: {} } as never);
    await until(() => vi.mocked(t.executor.start).mock.calls.length === 1);
    expect(get).toHaveBeenCalledWith(companyId);
    await t.manager.shutdown();
  });
});
