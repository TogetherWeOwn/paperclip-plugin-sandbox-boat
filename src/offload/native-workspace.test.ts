import { afterEach, describe, expect, it } from "vitest";
import plugin, { currentManager, setManagerOverridesForTests } from "../plugin.js";
import manifest from "../manifest.js";
import { createFakeContext } from "../test-support/harness.js";

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const workspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const commandId = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const actor = { actorType: "agent" as const, actorId: "agent-a", agentId: "agent-a", runId };
const body = { version: 1, commandId, executionWorkspaceId: workspaceId, cwdRelative: ".",
  argv: ["test", "--locked"], env: {}, queueTimeoutMs: 0, timeoutMs: 120_000, dryRun: true };

export function nativeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    driverKey: "boat", companyId, environmentId: "environment-a", config: {},
    lease: { providerLeaseId: null },
    workspace: { localPath: "/work/public-rust", remotePath: "/home/user/paperclip-workspace", metadata: {
      workspaceRealizationRequest: {
        version: 1, companyId, environmentId: "environment-a", heartbeatRunId: runId,
        executionWorkspaceId: workspaceId, source: {
          localPath: "/work/public-rust", projectId: "project-a", projectWorkspaceId: "pws-a",
          repoUrl: "https://github.com/example/public-rust",
        }, ...overrides,
      },
    } },
  };
}

/** The host starts every run with agent.run.started; pass start=false to rely on the persisted owner (a restarted worker). */
async function setup(state?: ReturnType<typeof createFakeContext>["ctx"]["state"], start = true) {
  const harness = createFakeContext();
  // Any attempt to use the SDK workspace client would require a new capability.
  const ctx = { ...harness.ctx, ...(state ? { state } : {}) };
  Object.defineProperty(ctx, "executionWorkspaces", { get() { throw new Error("capability unavailable"); } });
  await plugin.definition.setup(ctx as never);
  if (start) await currentManager().startLocalRun(companyId, runId, "issue-a", "agent-a");
  return harness;
}
async function submit(extra: Record<string, unknown> = {}) {
  return plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId, actor, body, params: {}, query: {}, ...extra } as never);
}

afterEach(async () => { await plugin.definition.onShutdown?.(); setManagerOverridesForTests({}); });

describe("native workspace binding", () => {
  it("pins the capability set: 0.2.2 plus the three local-run binding reads", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "environment.drivers.register", "plugin.state.read", "plugin.state.write",
      "jobs.schedule", "api.routes.register", "issues.read",
      "events.subscribe", "execution.workspaces.read", "secrets.read-ref",
    ].sort());
  });

  it("classifies from native realization metadata without the SDK workspace client", async () => {
    await setup();
    await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    expect(await submit()).toMatchObject({ status: 200, body: { mode: "remote_candidate" } });
  });

  it("persists only source metadata and survives a worker restart", async () => {
    const t = await setup();
    const params = nativeWorkspace({ runtimeOverlay: { provisionCommand: "sensitive-not-to-persist" } });
    await plugin.definition.onEnvironmentRealizeWorkspace!(params);
    expect(JSON.stringify([...t.state.values()])).not.toContain("sensitive-not-to-persist");
    expect(JSON.stringify([...t.state.values()])).not.toContain("/home/user/paperclip-workspace");
    await plugin.definition.onShutdown?.();
    await setup(t.ctx.state, false);
    expect(await submit()).toMatchObject({ status: 200 });
  });

  it("a run cleanup during a binding write leaves no binding behind", async () => {
    const t = await setup();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const originalSet = t.ctx.state.set;
    t.ctx.state.set = async (input: { namespace?: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces") await gate;
      return originalSet(input as never, value as never);
    };
    const realizing = plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    await new Promise((resolve) => setTimeout(resolve, 10)); // indexed, binding write pending
    const ending = t.emit("agent.run.finished", { companyId, payload: { runId, issueId: "issue-a" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    unblock();
    await Promise.all([realizing, ending]);
    t.ctx.state.set = originalSet;
    expect([...t.state.keys()].filter((key) => key.includes("boat-offload-workspaces"))).toEqual([]);
  });

  it("admits the owner of a whole-run realization whose run started without an issue", async () => {
    const t = await setup(undefined, false);
    await t.emit("agent.run.started", { companyId, payload: { runId, agentId: "agent-a", issueId: null } });
    await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    expect(await submit()).toMatchObject({ status: 200 });
  });

  it("does not bind another run or company to a known workspace", async () => {
    await setup();
    await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    expect(await submit({ actor: { ...actor, runId: "another-run" } })).toMatchObject({ status: 403 });
    expect(await submit({ companyId: "another-company" })).toMatchObject({ status: 403 });
  });

  it.each([
    {},
    { version: 2 },
    { companyId: "another-company" },
    { environmentId: "another-environment" },
    { heartbeatRunId: null },
    { executionWorkspaceId: null },
    { source: { localPath: "/etc", projectId: "project-a" } },
    { source: { localPath: "relative", projectId: "project-a" } },
  ])("does not bind missing or inconsistent native metadata %j", async (override) => {
    await setup();
    const params = nativeWorkspace(override);
    if (Object.keys(override).length === 0) params.workspace.metadata = {} as never;
    await plugin.definition.onEnvironmentRealizeWorkspace!(params);
    expect(await submit()).toMatchObject({ status: 403 });
  });

  it("uses the current native run identity, not stale reusable-lease metadata", async () => {
    await setup();
    const params = { ...nativeWorkspace(), lease: { providerLeaseId: null, metadata: { runId: "previous-run" } } };
    await plugin.definition.onEnvironmentRealizeWorkspace!(params);
    expect(await submit()).toMatchObject({ status: 200 });
    expect(await submit({ actor: { ...actor, runId: "previous-run" } })).toMatchObject({ status: 403 });
  });

  it.each(["version", "companyId", "runId", "workspaceId"])("fails closed on a corrupted persisted %s", async (field) => {
    const t = await setup();
    await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    const [key, value] = [...t.state.entries()].find(([key]) => key.includes("boat-offload-workspaces"))!;
    t.state.set(key, { ...(value as Record<string, unknown>), [field]: "wrong" });
    expect(await submit()).toMatchObject({ status: 403 });
  });

  it("does not break whole-run realization when optional offload state is unavailable", async () => {
    const t = await setup();
    await setup({ ...t.ctx.state, set: async () => { throw new Error("state unavailable"); } });
    expect(await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace()))
      .toMatchObject({ cwd: "/home/user/paperclip-workspace" });
    expect(await submit()).toMatchObject({ status: 403 });
  });

  it("never accepts a root or repo supplied in the offload body", async () => {
    await setup();
    expect(await submit({ body: { ...body, path: "/work/public-rust", repoUrl: "https://github.com/example/public-rust" } }))
      .toMatchObject({ status: 400 });
    expect(await submit()).toMatchObject({ status: 403 });
  });

  it("keeps normal submits default-off with a durable safe-fallback receipt", async () => {
    await setup();
    await plugin.definition.onEnvironmentRealizeWorkspace!(nativeWorkspace());
    expect(await submit({ body: { ...body, dryRun: false } })).toMatchObject({ status: 202 });
    expect(await currentManager().offloadRead(companyId, actor, { commandId }, {}))
      .toMatchObject({ status: 200, body: { state: "not_started", remoteStarted: false, fallbackSafe: true } });
  });
});
