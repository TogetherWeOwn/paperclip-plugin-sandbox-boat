import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { setRepoAuthForTests } from "./repo-auth.js";
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
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

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
    setRepoAuthForTests(async () => true);
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
    vi.setSystemTime(Date.now() + 1);
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
    setRepoAuthForTests(null);
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

  const unchanged = async (response: ReturnType<typeof report>, status = 403) => {
    const before = structuredClone([...harness.state.entries()]);
    expect((await response).status).toBe(status);
    expect([...harness.state.entries()]).toEqual(before);
    expect(historyEntries()).toEqual([]);
  };

  // The pinned SDK offers no atomic run source facts, so an unregistered run never learns, not even at start.
  it.each(commands)("fails closed for an unbound $tool report without reading the host workspace or persisting", async (command) => {
    const lookup = vi.spyOn(harness.ctx.executionWorkspaces, "get");
    await unchanged(report(command));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves no credential even when a local environment and secret are configured", async () => {
    const secretId = randomUUID();
    harness.secrets.set(secretId, "fake-scoped-key");
    config.offloadLocalEnvironmentId = randomUUID();
    config.offloadLocalApiKeySecretRef = { type: "secret_ref", secretId };
    await unchanged(report());
    expect(JSON.stringify([...harness.state.values()])).not.toContain("fake-scoped-key");
  });

  it.each(commands)("an unbound $tool refusal leaves a fresh real submit or dry-run unadmitted under an exact grant", async (command) => {
    // A null policy is the broad path; an exact grant naming another run applies here.
    config.offloadAdmission = { version: 1, companyId, agentId, runId: randomUUID(), executionWorkspaceId: workspaceId,
      commandId: randomUUID(), issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await unchanged(report(command));
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

  it.each([workspaceId, projectWorkspaceId])("refuses the host-owned execution/project id %s while unbound", async (id) => {
    await unchanged(report(commands[0], {}, { executionWorkspaceId: id }));
  });

  it("refuses an issue's project workspace fallback while unbound", async () => {
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null, executionRunId: runId });
    harness.projectWorkspaces.set(issueId, { id: projectWorkspaceId, projectId: "project", path: dir, repoUrl });
    await unchanged(report(commands[1], {}, { executionWorkspaceId: projectWorkspaceId }));
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

  it("never reads host workspace metadata for a report, even when the run ends concurrently", async () => {
    const lookup = vi.spyOn(harness.ctx.executionWorkspaces, "get");
    const pending = report();
    await harness.emit("agent.run.finished", { companyId, payload: { runId } });
    expect((await pending).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(historyEntries()).toEqual([]);
  });

  it("keeps report validation before any dispatch or metadata persistence, and never records while unbound", async () => {
    expect((await report(commands[0], {}, { durationSeconds: 86_401 })).status).toBe(400);
    expect((await report(commands[0], {}, { argv: ["run", "watch"] })).status).toBe(400);
    const before = structuredClone([...harness.state.entries()]);
    for (let i = 0; i < 5; i++) expect((await report()).status).toBe(403);
    expect((await report()).status).toBe(429);
    expect([...harness.state.entries()]).toEqual(before);
    expect(historyEntries()).toEqual([]);
  });
});

describe("local duration reports with registered workspace refusals", () => {
  let dir: string;

  afterEach(async () => {
    await plugin.definition.onShutdown?.();
    setManagerOverridesForTests({});
    setRepoAuthForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(commands.flatMap((command) => [true, false].map((withdrawn) => ({ ...command, withdrawn }))))(
    "honors registrations without host workspace reads for $tool (withdrawn=$withdrawn)", async (command) => {
      resetReportBudgets();
      // Bare .git/config fixtures have no HEAD to authenticate; fail closed
      // without contacting a remote so start stays unbound.
      setRepoAuthForTests(async () => false);
      dir = await mkdtemp(path.join(tmpdir(), "boat-duration-inflight-"));
      const sources = [
        { id: workspaceId, root: path.join(dir, "a"), repo: repoUrl },
        { id: randomUUID(), root: path.join(dir, "b"), repo: "https://github.com/example/other" },
      ];
      for (const source of sources) {
        await mkdir(path.join(source.root, ".git"), { recursive: true });
        await writeFile(path.join(source.root, ".git", "config"), `[remote "origin"]\nurl = ${source.repo}\n`);
      }
      const harness = createFakeContext({
        issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: sources[1]!.id, executionRunId: runId }]]),
        workspaces: new Map(sources.map((source) => [source.id, {
          projectId: "project", projectWorkspaceId, path: source.root, cwd: source.root, repoUrl: source.repo,
        }])),
      });
      // A null policy is the broad path; an exact grant naming another command applies here.
      const admission = { version: 1, companyId, agentId, runId, executionWorkspaceId: workspaceId, commandId: randomUUID(),
        issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      harness.ctx.config.get = async () => ({ offloadLocalRunsEnabled: true, offloadLocalSourceRoots: [dir],
        offloadExecutorEnabled: false, offloadGuestTransportEnabled: false, offloadAdmission: admission });
      const executor = vi.fn(async () => { throw new Error("unexpected executor resolution"); });
      setManagerOverridesForTests({ offloadExecutor: executor });
      await plugin.definition.setup(harness.ctx as never);
      vi.setSystemTime(Date.now() + 1);
      await harness.emit("agent.run.started", started);
      const secret = vi.spyOn(harness.ctx.secrets, "resolve");
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
      const report = (id: string) => plugin.definition.onApiRequest!({ routeKey: "offload_report", companyId,
        actor: { actorType: "agent", actorId: agentId, agentId, runId }, params: {}, query: {},
        body: { executionWorkspaceId: id, tool: command.tool, runner: command.runner, argv: command.argv, durationSeconds: 120 },
      } as never);
      const lookup = vi.spyOn(harness.ctx.executionWorkspaces, "get");
      const registry = new NativeOffloadWorkspaces(harness.ctx.state);
      expect(await registry.lookup(projectWorkspaceId, companyId, runId)).toBeUndefined();
      // Unregistered, the shared alias is unbound: refused without any host workspace read or write.
      const unbound = structuredClone([...harness.state.entries()]);
      expect(await report(projectWorkspaceId)).toMatchObject({ status: 403 });
      expect([...harness.state.entries()]).toEqual(unbound);
      resetReportBudgets();
      // Trusted registration binds A or withdraws their shared alias.
      for (const source of command.withdrawn ? sources : sources.slice(0, 1)) {
        await registry.remember({ companyId, environmentId: "environment", workspace: {
          localPath: source.root, metadata: { workspaceRealizationRequest: {
            version: 1, companyId, environmentId: "environment", heartbeatRunId: runId,
            executionWorkspaceId: source.id, localRun: true,
            source: { localPath: source.root, projectId: "project", projectWorkspaceId, repoUrl: source.repo },
          } },
        } } as never);
      }
      expect(await registry.lookup(projectWorkspaceId, companyId, runId))
        .toEqual(command.withdrawn ? null : expect.objectContaining({ repoUrl }));
      const before = structuredClone([...harness.state.entries()]);
      expect(await report(projectWorkspaceId)).toMatchObject({ status: command.withdrawn ? 403 : 200 });
      if (command.withdrawn) expect([...harness.state.entries()]).toEqual(before);
      else {
        const key = durationKey(`repo:${repoUrl}`, command.profile, normalizeSignature(command.tool, command.runner, command.argv));
        expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: key }))
          .toEqual([{ seconds: 120, at: expect.any(Number) }]);
        expect([...harness.state.entries()].filter(([stateKey]) => stateKey.includes("offload.duration.v1."))).toHaveLength(1);
      }
      resetReportBudgets();
      for (const source of command.withdrawn ? sources : sources.slice(0, 1)) {
        expect(await report(source.id)).toMatchObject({ status: 200, body: { recorded: true } });
        const key = durationKey(`repo:${source.repo}`, command.profile, normalizeSignature(command.tool, command.runner, command.argv));
        expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: key }))
          .toHaveLength(command.withdrawn ? 1 : 2);
      }
      // Even valid registered learning is not a grant for another command.
      const afterLearning = structuredClone([...harness.state.entries()]);
      for (const dryRun of [false, true]) {
        expect(await plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
          actor: { actorType: "agent", actorId: agentId, agentId, runId, authenticatedRunId: runId }, params: {}, query: {},
          body: { version: 1, commandId: randomUUID(), executionWorkspaceId: workspaceId,
            tool: command.tool, runner: command.runner, argv: command.argv, cwdRelative: ".", env: {},
            queueTimeoutMs: 0, timeoutMs: 10_000, dryRun } } as never)).toMatchObject({ status: 403 });
      }
      expect([...harness.state.entries()]).toEqual(afterLearning);
      expect([...harness.state.entries()].filter(([key]) => !key.includes("offload.duration")))
        .toEqual(before.filter(([key]) => !key.includes("offload.duration")));
      expect(lookup).not.toHaveBeenCalled();
      expect(secret).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(commands)("rejects a withdrawn alias without training either repository for $tool, but accepts primary IDs", async (command) => {
    resetReportBudgets();
    setRepoAuthForTests(async () => false);
    dir = await mkdtemp(path.join(tmpdir(), "boat-duration-alias-"));
    const otherWorkspaceId = randomUUID();
    const sources = [
      { id: workspaceId, root: path.join(dir, "a"), repo: repoUrl },
      { id: otherWorkspaceId, root: path.join(dir, "b"), repo: "https://github.com/example/other" },
    ];
    for (const source of sources) {
      await mkdir(path.join(source.root, ".git"), { recursive: true });
      await writeFile(path.join(source.root, ".git", "config"), `[remote "origin"]\nurl = ${source.repo}\n`);
    }
    // A completed while the issue now points at B; both used the same project alias.
    const harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: otherWorkspaceId, executionRunId: runId }]]),
      workspaces: new Map(sources.map((source) => [source.id, {
        projectId: "project", projectWorkspaceId, path: source.root, cwd: source.root, repoUrl: source.repo,
      }])),
    });
    harness.ctx.config.get = async () => ({ offloadLocalRunsEnabled: true, offloadLocalSourceRoots: [dir],
      offloadExecutorEnabled: false, offloadGuestTransportEnabled: false });
    const executor = vi.fn(async () => { throw new Error("unexpected executor resolution"); });
    setManagerOverridesForTests({ offloadExecutor: executor });
    await plugin.definition.setup(harness.ctx as never);
    vi.setSystemTime(Date.now() + 1);
    await harness.emit("agent.run.started", started);
    const registry = new NativeOffloadWorkspaces(harness.ctx.state);
    for (const source of sources) {
      await registry.remember({ companyId, environmentId: "environment", workspace: {
        localPath: source.root, metadata: { workspaceRealizationRequest: {
          version: 1, companyId, environmentId: "environment", heartbeatRunId: runId,
          executionWorkspaceId: source.id, localRun: true,
          source: { localPath: source.root, projectId: "project", projectWorkspaceId, repoUrl: source.repo },
        } },
      } } as never);
    }
    expect(await registry.get(projectWorkspaceId, companyId, runId)).toBeNull();
    expect([...harness.state.values()]).toContainEqual(expect.objectContaining({ workspaceId: projectWorkspaceId, ambiguous: true }));
    const lookup = vi.spyOn(harness.ctx.executionWorkspaces, "get");
    const secret = vi.spyOn(harness.ctx.secrets, "resolve");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
    const report = (id: string) => plugin.definition.onApiRequest!({ routeKey: "offload_report", companyId,
      actor: { actorType: "agent", actorId: agentId, agentId, runId }, params: {}, query: {},
      body: { executionWorkspaceId: id, tool: command.tool, runner: command.runner, argv: command.argv, durationSeconds: 120 },
    } as never);
    const before = structuredClone([...harness.state.entries()]);
    expect(await report(projectWorkspaceId)).toMatchObject({ status: 403 });
    expect([...harness.state.entries()]).toEqual(before);
    expect(lookup).not.toHaveBeenCalled();
    const [primaryKey, primary] = before.find(([, value]) => (value as { workspaceId?: string }).workspaceId === otherWorkspaceId)!;
    // Invalid registered metadata is also a refusal, even though B is resolvable from the host.
    for (const invalid of [{}, { ...(primary as object), version: 2 }, { ...(primary as object), companyId: randomUUID() }]) {
      harness.state.set(primaryKey, invalid);
      const invalidState = structuredClone([...harness.state.entries()]);
      expect(await report(otherWorkspaceId)).toMatchObject({ status: 403 });
      expect([...harness.state.entries()]).toEqual(invalidState);
      expect(lookup).not.toHaveBeenCalled();
    }
    harness.state.set(primaryKey, primary);
    resetReportBudgets(); // Primary-ID behavior is independent of the rejection burst above.
    for (const source of sources) {
      expect(await report(source.id)).toMatchObject({ status: 200, body: { recorded: true } });
      const key = durationKey(`repo:${source.repo}`, command.profile, normalizeSignature(command.tool, command.runner, command.argv));
      expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: key }))
        .toEqual([{ seconds: 120, at: expect.any(Number) }]);
    }
    expect(await report(projectWorkspaceId)).toMatchObject({ status: 403 });
    expect([...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces")))
      .toEqual(before.filter(([key]) => key.includes("boat-offload-workspaces")));
    expect(secret).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
