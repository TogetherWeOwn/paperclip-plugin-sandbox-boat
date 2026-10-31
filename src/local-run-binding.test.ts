import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFakeContext } from "./test-support/harness.js";
import { localRunRealization, localRunSettings, type LocalRunHost } from "./local-run-binding.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const issueId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const workspaceId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const environmentId = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const secretId = "ffffffff-ffff-4fff-ffff-ffffffffffff";
const agentId = "abcdabcd-abcd-4bcd-abcd-abcdabcdabcd";
const secretRef = { type: "secret_ref", secretId };
const enabled = { offloadLocalRunsEnabled: true, offloadLocalEnvironmentId: environmentId, offloadLocalApiKeySecretRef: secretRef,
  offloadLocalDriverConfig: { maxOffloadVms: 1, apiKey: "must-not-win" } };
const started = { companyId, payload: { runId, issueId, agentId, status: "running" } };

function host(overrides: Partial<LocalRunHost> = {}): LocalRunHost {
  return {
    issueWorkspaceId: async () => workspaceId,
    workspace: async () => ({ projectId: "project", projectWorkspaceId: null, path: "/srv/work/repo", repoUrl: "https://github.com/example/public" }),
    apiKey: async () => "scoped-key",
    ...overrides,
  };
}

describe("local-run offload binding", () => {
  it("builds the native realization payload only from host-owned run, issue and workspace data", async () => {
    const params = await localRunRealization(started, localRunSettings(enabled), host());
    expect(params).toMatchObject({
      companyId, environmentId, config: { maxOffloadVms: 1, apiKey: "scoped-key" },
      workspace: { localPath: "/srv/work/repo", metadata: { workspaceRealizationRequest: {
        version: 1, companyId, environmentId, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
        source: { localPath: "/srv/work/repo", repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null },
      } } },
    });
  });

  it.each([
    ["disabled", { ...enabled, offloadLocalRunsEnabled: false }, host()],
    ["flag not boolean true", { ...enabled, offloadLocalRunsEnabled: "true" }, host()],
    ["no environment", { ...enabled, offloadLocalEnvironmentId: "not-a-uuid" }, host()],
    ["no secret ref", { ...enabled, offloadLocalApiKeySecretRef: undefined }, host()],
    ["issue has no execution workspace", enabled, host({ issueWorkspaceId: async () => null })],
    ["workspace unknown", enabled, host({ workspace: async () => null })],
    ["workspace not locally realized", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: null, repoUrl: null }) })],
    ["relative workspace path", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "repo", repoUrl: null }) })],
    ["secret resolves empty", enabled, host({ apiKey: async () => null })],
  ])("binds nothing when %s", async (_name, settings, fakeHost) => {
    expect(await localRunRealization(started, localRunSettings(settings), fakeHost)).toBe(null);
  });

  it("ignores events whose run or issue id is not a UUID", async () => {
    for (const payload of [{ runId: "x", issueId }, { runId, issueId: null }, null]) {
      expect(await localRunRealization({ companyId, payload }, localRunSettings(enabled), host())).toBe(null);
    }
  });
});

describe("plugin wiring", () => {
  let dir: string | null = null;
  afterEach(async () => {
    await plugin.definition.onShutdown?.(); setManagerOverridesForTests({});
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function setup(config: Record<string, unknown>, configGet?: () => Promise<Record<string, unknown>>) {
    dir = await mkdtemp(path.join(tmpdir(), "boat-local-run-"));
    const harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: workspaceId, executionRunId: runId }]]),
      workspaces: new Map([[workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null, path: dir, cwd: dir }]]),
    });
    harness.secrets.set(secretId, "scoped-key");
    await plugin.definition.setup({ ...harness.ctx, config: { get: configGet ?? (async () => config) } } as never);
    return harness;
  }
  const exec = (actorRunId: string) => plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
    actor: { actorType: "agent", actorId: agentId, agentId, runId: actorRunId }, params: {}, query: {},
    body: { version: 1, commandId: randomUUID(), executionWorkspaceId: workspaceId, argv: ["test", "--locked"], cwdRelative: ".", env: {},
      queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: true } } as never);

  it("admits the started run's own workspace after agent.run.started, and only that run", async () => {
    const harness = await setup(enabled);
    expect((await exec(runId)).status).toBe(403);
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(200);
    expect((await exec(randomUUID())).status).toBe(403);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(true);
  });

  it("binds on the first offload request when the workspace was prepared after the started event", async () => {
    const harness = await setup(enabled);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null });
    await harness.emit("agent.run.started", started);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: workspaceId });
    expect((await exec(runId)).status).toBe(200);
    expect((await exec(randomUUID())).status).toBe(403);
  });

  it.each(["agent.run.finished", "agent.run.failed", "agent.run.cancelled"])("%s revokes the run's offload authority", async (terminal) => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(200);
    await harness.emit(terminal, { companyId, payload: { runId, issueId } });
    expect((await exec(runId)).status).toBe(403);
    // A late started delivery cannot revive an ended run.
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(403);
  });

  it("a terminal event during a slow start handler leaves no binding", async () => {
    const harness = await setup(enabled);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = harness.ctx.issues.get;
    harness.ctx.issues.get = async (id: string) => { await gate; return original(id); };
    const pending = harness.emit("agent.run.started", started);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    release();
    await pending;
    harness.ctx.issues.get = original;
    expect((await exec(runId)).status).toBe(403);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
  });

  it("a terminal event while the workspace record is being written leaves no binding", async () => {
    const harness = await setup(enabled);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    const originalSet = harness.ctx.state.set;
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces") { reached(); await gate; }
      return originalSet(input, value);
    };
    const pending = harness.emit("agent.run.started", started);
    await writing;
    // The terminal event queues behind the in-flight write (same per-run lock), then removes it.
    const ending = harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([pending, ending]);
    harness.ctx.state.set = originalSet;
    expect((await exec(runId)).status).toBe(403);
    expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
  });

  it("a terminal event removes only that run's executor binding", async () => {
    const harness = await setup(enabled);
    const otherRun = "abababab-abab-4bab-abab-abababababab";
    await harness.emit("agent.run.started", started);
    await harness.emit("agent.run.started", { companyId, payload: { runId: otherRun, issueId } });
    const manager = (await import("./plugin.js")).currentManager();
    expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(true);
    expect(manager.hasOffloadBinding(companyId, otherRun, workspaceId)).toBe(true);
    await harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
    expect(manager.hasOffloadBinding(companyId, otherRun, workspaceId)).toBe(true);
  });

  it("a whole-run realization landing while the local record is written keeps both stores", async () => {
    const harness = await setup(enabled);
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-race-"));
    const nativeEnv = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    const originalSet = harness.ctx.state.set;
    let gated = false;
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces" && !gated) { gated = true; reached(); await gate; }
      return originalSet(input, value);
    };
    try {
      const pending = harness.emit("agent.run.started", started);
      await writing;
      const realizing = plugin.definition.onEnvironmentRealizeWorkspace!({ driverKey: "boat", companyId, environmentId: nativeEnv,
        config: { apiKey: "native-key" }, lease: { providerLeaseId: null },
        workspace: { localPath: nativeSource, metadata: { workspaceRealizationRequest: { version: 1, companyId,
          environmentId: nativeEnv, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
          source: { localPath: nativeSource, repoUrl: null, projectId: "native-project", projectWorkspaceId: null } } } } } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await Promise.all([pending, realizing]);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
      const saved = [...harness.state.entries()].find(([key]) => key.includes("boat-offload-workspaces"))?.[1] as { workspace?: { path?: string } };
      expect(saved?.workspace?.path).toBe(nativeSource);
    } finally {
      harness.ctx.state.set = originalSet;
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  it("a failed state write on the first offload request answers 403 and stays retryable", async () => {
    const harness = await setup(enabled);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null });
    await harness.emit("agent.run.started", started);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: workspaceId });
    const originalSet = harness.ctx.state.set;
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces") throw new Error("state store unavailable");
      return originalSet(input, value);
    };
    expect((await exec(runId)).status).toBe(403);
    harness.ctx.state.set = originalSet;
    expect((await exec(runId)).status).toBe(200);
  });

  it("a config read failure at run start is recovered on the first offload request", async () => {
    let calls = 0;
    const harness = await setup(enabled, async () => { calls += 1; if (calls === 1) throw new Error("config unavailable"); return enabled; });
    await harness.emit("agent.run.started", started);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    expect((await exec(runId)).status).toBe(200);
  });

  it("never replaces a whole-run native realization for the same run and workspace", async () => {
    const harness = await setup(enabled);
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-"));
    const nativeEnv = randomUUID();
    try {
      await plugin.definition.onEnvironmentRealizeWorkspace!({ driverKey: "boat", companyId, environmentId: nativeEnv,
        config: { apiKey: "native-key" }, lease: { providerLeaseId: null },
        workspace: { localPath: nativeSource, metadata: { workspaceRealizationRequest: { version: 1, companyId,
          environmentId: nativeEnv, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
          source: { localPath: nativeSource, repoUrl: null, projectId: "native-project", projectWorkspaceId: null } } } } } as never);
      const manager = (await import("./plugin.js")).currentManager();
      expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(true);
      await harness.emit("agent.run.started", started);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    } finally {
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  const workspaceBindings = (harness: Awaited<ReturnType<typeof setup>>) =>
    [...harness.state.keys()].filter((key) => key.includes("boat-offload-workspaces"));
  const restart = async (harness: Awaited<ReturnType<typeof setup>>) => {
    await plugin.definition.onShutdown?.();
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => enabled } } as never);
  };

  it("refuses a run whose owner is unknown: a started event without an agent", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", { companyId, payload: { runId, issueId, status: "running" } });
    expect((await exec(runId)).status).toBe(403);
  });

  it("refuses a bound run that this worker never saw start", async () => {
    await setup(enabled);
    await (await import("./plugin.js")).currentManager().rememberOffloadWorkspace((await localRunRealization(started, localRunSettings(enabled), host()))!);
    expect((await exec(runId)).status).toBe(403);
  });

  it("a restarted worker keeps the persisted owner: the owner is admitted, another agent is not", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    await restart(harness);
    expect((await exec(runId)).status).toBe(200);
    const other = await plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
      actor: { actorType: "agent", actorId: randomUUID(), agentId: randomUUID(), runId }, params: {}, query: {},
      body: { version: 1, commandId: randomUUID(), executionWorkspaceId: workspaceId, argv: ["test"], cwdRelative: ".", env: {},
        queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: true } } as never);
    expect(other.status).toBe(403);
  });

  it("a run still active after more than a day keeps its owner across a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const harness = await setup(enabled);
      await harness.emit("agent.run.started", started);
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
      await restart(harness);
      expect((await exec(runId)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a terminal event forgets the run's persisted workspace bindings and owner after a worker restart", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    expect(workspaceBindings(harness)).toHaveLength(1);
    await restart(harness); // nothing about the run in memory
    await harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    expect(workspaceBindings(harness)).toEqual([]);
    expect([...harness.state.keys()].some((key) => key.includes("boat-offload-run"))).toBe(false);
    expect((await exec(runId)).status).toBe(403);
  });

  it("a finished run stays refused after a restart even when deleting its owner record fails", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    const originalDelete = harness.ctx.state.delete;
    harness.ctx.state.delete = async (input: { namespace?: string }) => {
      if (input.namespace === "boat-offload-runs") throw new Error("state unavailable");
      return originalDelete(input as never);
    };
    await harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    harness.ctx.state.delete = originalDelete;
    await restart(harness);
    expect((await exec(runId)).status).toBe(403);
  });

  it("a finished run stays refused after a restart when every write of its owner record fails", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    const { delete: originalDelete, set: originalSet } = harness.ctx.state;
    harness.ctx.state.delete = async (input: { namespace?: string }) => {
      if (input.namespace === "boat-offload-runs") throw new Error("state unavailable");
      return originalDelete(input as never);
    };
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-runs") throw new Error("state unavailable");
      return originalSet(input, value);
    };
    await harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
    harness.ctx.state.delete = originalDelete;
    harness.ctx.state.set = originalSet;
    // The host no longer shows the run on its issue.
    harness.issues.set(issueId, { status: "done", executionWorkspaceId: workspaceId, executionRunId: null });
    await restart(harness);
    expect((await exec(runId)).status).toBe(403);
  });

  it("a restarted worker trusts the saved owner of a run without an issue for a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const harness = await setup(enabled);
      await harness.emit("agent.run.started", { companyId, payload: { runId, issueId: null, agentId, status: "running" } });
      await restart(harness);
      const manager = () => import("./plugin.js").then((module) => module.currentManager());
      expect(await (await manager()).localRunOwnedBy(companyId, runId, agentId)).toBe(true);
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
      await restart(harness);
      expect(await (await manager()).localRunOwnedBy(companyId, runId, agentId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves local runs unbound while the setting is off", async () => {
    const harness = await setup({});
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(403);
  });
});
