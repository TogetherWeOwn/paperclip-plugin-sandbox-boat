import { afterEach, describe, expect, it } from "vitest";
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
const secretRef = { type: "secret_ref", secretId };
const enabled = { offloadLocalRunsEnabled: true, offloadLocalEnvironmentId: environmentId, offloadLocalApiKeySecretRef: secretRef,
  offloadLocalDriverConfig: { maxOffloadVms: 1, apiKey: "must-not-win" } };
const started = { companyId, payload: { runId, issueId, agentId: randomUUID(), status: "running" } };

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

  async function setup(config: Record<string, unknown>) {
    dir = await mkdtemp(path.join(tmpdir(), "boat-local-run-"));
    const harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: workspaceId }]]),
      workspaces: new Map([[workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null, path: dir, cwd: dir }]]),
    });
    harness.secrets.set(secretId, "scoped-key");
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => config } } as never);
    return harness;
  }
  const exec = (actorRunId: string) => plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
    actor: { actorType: "agent", actorId: randomUUID(), runId: actorRunId }, params: {}, query: {},
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

  it("leaves local runs unbound while the setting is off", async () => {
    const harness = await setup({});
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(403);
  });
});
