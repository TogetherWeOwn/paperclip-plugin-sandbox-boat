import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { createFakeContext } from "./test-support/harness.js";
import { durationKey, medianSeconds, normalizeSignature, readHistory } from "./offload/duration-history.js";
import { resetReportBudgets } from "./offload/routes.js";
import { NativeOffloadWorkspaces } from "./offload/workspaces.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const issueId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const workspaceId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const projectWorkspaceId = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const agentId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const repoUrl = "https://github.com/example/public";
const started = { companyId, payload: { runId, issueId, agentId } };
const commands = [
  { tool: "node", runner: "npm", argv: ["test"], profile: "node-public-1" },
  { tool: "python", runner: "pytest", argv: ["tests"], profile: "python-public-1" },
];

describe("local-run duration learning through plugin dispatch", () => {
  let dir: string;
  let harness: ReturnType<typeof createFakeContext>;
  let config: Record<string, unknown>;
  let effects: ReturnType<typeof vi.spyOn>[];

  beforeEach(async () => {
    resetReportBudgets();
    dir = await mkdtemp(path.join(tmpdir(), "boat-local-duration-"));
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${repoUrl}\n`);
    harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: workspaceId, executionRunId: runId }]]),
      workspaces: new Map([[workspaceId, { projectId: "project", projectWorkspaceId, path: dir, cwd: dir, repoUrl }]]),
    });
    // Learning has no grant, environment or credential. Executor and guest flags stay OFF.
    config = { offloadLocalRunsEnabled: true, offloadExecutorEnabled: false, offloadGuestTransportEnabled: false,
      offloadLocalSourceRoots: [dir] };
    harness.ctx.config.get = async () => config;
    const executor = vi.fn(async () => { throw new Error("unexpected executor resolution"); });
    setManagerOverridesForTests({ offloadExecutor: executor });
    await plugin.definition.setup(harness.ctx as never);
    const manager = currentManager();
    effects = [executor, vi.spyOn(harness.ctx.secrets, "resolve"), vi.spyOn(manager, "rememberLocalRun"),
      vi.spyOn(manager, "rememberOffloadWorkspace"), vi.spyOn(manager, "acquire"), vi.spyOn(manager, "resumeLease"),
      vi.spyOn(manager, "probe"), vi.spyOn(manager, "realizeWorkspace"),
      vi.spyOn(NativeOffloadWorkspaces.prototype, "remember"), vi.spyOn(SshOffloadRuntime.prototype, "remember"),
      vi.spyOn(SshOffloadRuntime.prototype, "resolve")];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
    await harness.emit("agent.run.started", started);
  });

  afterEach(async () => {
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
    expect(currentManager().hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(false);
    expect([...harness.state.keys()].filter((key) => key.includes("boat-offload-workspaces")
      || key.includes("boat-offload-admission") || key.startsWith("instance|"))).toEqual([]);
    await plugin.definition.onShutdown?.();
    setManagerOverridesForTests({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const report = (command = commands[0]!, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) =>
    plugin.definition.onApiRequest!({ routeKey: "offload_report", companyId,
      actor: { actorType: "agent", actorId: agentId, agentId, runId }, params: {}, query: {},
      body: { executionWorkspaceId: workspaceId, tool: command.tool, runner: command.runner,
        argv: command.argv, durationSeconds: 120, ...body }, ...extra } as never);
  const historyEntries = () => [...harness.state.entries()].filter(([key]) => key.includes("offload.duration.v1."));

  it.each(commands)("records one $tool local sample without admission, and reads its bounded persisted history", async (command) => {
    const before = structuredClone([...harness.state.entries()]);
    expect(await report(command)).toMatchObject({ status: 200, body: { recorded: true } });
    const key = durationKey(`repo:${repoUrl}`, command.profile, normalizeSignature(command.tool, command.runner, command.argv));
    const store = {
      get: (stateKey: string) => harness.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey }),
      set: async () => {}, delete: async () => {},
    };
    const history = await readHistory(store, key);
    expect(history).toEqual([{ seconds: 120, at: expect.any(Number) }]);
    expect(medianSeconds(history, Date.now())).toBe(120);
    expect(historyEntries()).toHaveLength(1);
    // The only new persistent state is the sample and the bounded duration index.
    expect([...harness.state.entries()].filter(([k]) => !k.includes("offload.duration"))).toEqual(before);
    expect([...harness.state.keys()].filter((k) => k.includes("offload.duration-index"))).toHaveLength(1);
  });

  it("resolves no credential even when a local environment and secret are configured", async () => {
    const secretId = randomUUID();
    harness.secrets.set(secretId, "fake-scoped-key");
    config.offloadLocalEnvironmentId = randomUUID();
    config.offloadLocalApiKeySecretRef = { type: "secret_ref", secretId };
    expect((await report()).status).toBe(200);
    expect(JSON.stringify([...harness.state.values()])).not.toContain("fake-scoped-key");
  });

  it.each(commands)("a learned $tool sample cannot admit a fresh real submit or dry-run", async (command) => {
    expect((await report(command)).status).toBe(200);
    const before = structuredClone([...harness.state.entries()]);
    for (const dryRun of [false, true]) {
      const response = await plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
        actor: { actorType: "agent", actorId: agentId, agentId, runId, authenticatedRunId: runId }, params: {}, query: {},
        body: { version: 1, commandId: randomUUID(), executionWorkspaceId: workspaceId,
          tool: command.tool, runner: command.runner, argv: command.argv, cwdRelative: ".", env: {},
          queueTimeoutMs: 0, timeoutMs: 10_000, dryRun } } as never);
      expect(response).toMatchObject({ status: 403, body: { code: "OFFLOAD_FORBIDDEN" } });
    }
    expect([...harness.state.entries()]).toEqual(before);
  });

  it.each([workspaceId, projectWorkspaceId])("accepts only the host-owned execution/project id %s", async (id) => {
    expect((await report(commands[0], {}, { executionWorkspaceId: id })).status).toBe(200);
    expect(historyEntries()).toHaveLength(1);
  });

  it("uses the issue's project workspace when it has no execution workspace", async () => {
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null, executionRunId: runId });
    harness.projectWorkspaces.set(issueId, { id: projectWorkspaceId, projectId: "project", path: dir, repoUrl });
    expect((await report(commands[1], {}, { executionWorkspaceId: projectWorkspaceId })).status).toBe(200);
    expect(historyEntries()).toHaveLength(1);
  });

  it.each(["run", "agent", "company", "workspace", "no run", "user"])("rejects the wrong %s without state changes", async (wrong) => {
    const actor = { actorType: "agent", actorId: agentId, agentId, runId };
    const extra = wrong === "company" ? { companyId: randomUUID() }
      : wrong === "run" ? { actor: { ...actor, runId: randomUUID() } }
      : wrong === "agent" ? { actor: { ...actor, agentId: randomUUID() } }
      : wrong === "no run" ? { actor: { ...actor, runId: null } }
      : wrong === "user" ? { actor: { actorType: "user", actorId: "user" } } : {};
    const before = structuredClone([...harness.state.entries()]);
    expect((await report(commands[0], extra, wrong === "workspace" ? { executionWorkspaceId: randomUUID() } : {})).status)
      .toBe(["no run", "user"].includes(wrong) ? 401 : 403);
    expect([...harness.state.entries()]).toEqual(before);
  });

  it.each(["flags OFF", "outside roots", "wrong origin", "no workspace", "lookup fails", "config fails"])("refuses metadata resolution with %s", async (reason) => {
    if (reason === "flags OFF") config.offloadLocalRunsEnabled = false;
    if (reason === "outside roots") config.offloadLocalSourceRoots = [path.join(dir, "other")];
    if (reason === "wrong origin") await writeFile(path.join(dir, ".git", "config"), '[remote "origin"]\nurl = https://github.com/example/other\n');
    if (reason === "no workspace") harness.workspaces.clear();
    if (reason === "lookup fails") harness.ctx.executionWorkspaces.get = async () => { throw new Error("unavailable"); };
    if (reason === "config fails") harness.ctx.config.get = async () => { throw new Error("unavailable"); };
    const before = structuredClone([...harness.state.entries()]);
    expect((await report()).status).toBe(403);
    expect([...harness.state.entries()]).toEqual(before);
  });

  it.each(["agent.run.finished", "agent.run.failed", "agent.run.cancelled"])("rejects reports after %s", async (terminal) => {
    await harness.emit(terminal, { companyId, payload: { runId } });
    expect((await report()).status).toBe(403);
    expect(historyEntries()).toEqual([]);
  });

  it("rejects a run ending during the host metadata lookup", async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    const original = harness.ctx.executionWorkspaces.get;
    harness.ctx.executionWorkspaces.get = async (id) => { reached(); await gate; return original(id); };
    const pending = report();
    await reading;
    await harness.emit("agent.run.finished", { companyId, payload: { runId } });
    release();
    expect((await pending).status).toBe(403);
    expect(historyEntries()).toEqual([]);
  });

  it("keeps report validation and rate bounds before any dispatch or metadata persistence", async () => {
    expect((await report(commands[0], {}, { durationSeconds: 86_401 })).status).toBe(400);
    expect((await report(commands[0], {}, { argv: ["run", "watch"] })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await report()).status).toBe(200);
    expect((await report()).status).toBe(429);
    expect(historyEntries()[0]?.[1]).toHaveLength(5);
  });
});
