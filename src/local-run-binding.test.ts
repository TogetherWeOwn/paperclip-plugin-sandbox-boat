import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFakeContext } from "./test-support/harness.js";
import { localRunRealization, localRunSettings, readGitOriginUrl, type LocalRunHost } from "./local-run-binding.js";
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
  offloadLocalSourceRoots: ["/srv/work", tmpdir()],
  offloadLocalDriverConfig: { maxOffloadVms: 1, apiKey: "must-not-win" } };
const started = { companyId, payload: { runId, issueId, agentId, status: "running" } };

function host(overrides: Partial<LocalRunHost> = {}): LocalRunHost {
  return {
    issueWorkspaceId: async () => workspaceId,
    issueProjectWorkspace: async () => null,
    workspace: async () => ({ projectId: "project", projectWorkspaceId: null, path: "/srv/work/repo", repoUrl: "https://github.com/example/public" }),
    canonicalPath: async (localPath) => localPath,
    onDiskRepoUrl: async () => "https://github.com/example/public",
    apiKey: async () => "scoped-key",
    ...overrides,
  };
}

const projectWorkspaceId = "11111111-1111-4111-8111-111111111111";

describe("local-run offload binding", () => {
  it("builds the native realization payload only from host-owned run, issue and workspace data", async () => {
    const params = await localRunRealization(started, localRunSettings(enabled), host());
    expect(params).toMatchObject({
      companyId, environmentId, config: { maxOffloadVms: 1, apiKey: "scoped-key" },
      workspace: { localPath: "/srv/work/repo", metadata: { workspaceRealizationRequest: {
        version: 1, companyId, environmentId, heartbeatRunId: runId, executionWorkspaceId: workspaceId, localRun: true,
        source: { localPath: "/srv/work/repo", repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null },
      } } },
    });
  });

  it("binds the canonical path and the on-disk origin URL, not the workspace row's spellings", async () => {
    const params = await localRunRealization(started, localRunSettings(enabled), host({
      workspace: async () => ({ projectId: "project", projectWorkspaceId: null, path: "/srv/work/link", repoUrl: "https://github.com/example/public" }),
      canonicalPath: async (localPath) => (localPath === "/srv/work/link" ? "/srv/work/repo" : localPath),
      onDiskRepoUrl: async () => "https://github.com/example/public.git",
    }));
    expect(params).toMatchObject({
      workspace: { localPath: "/srv/work/repo", metadata: { workspaceRealizationRequest: {
        localRun: true,
        source: { localPath: "/srv/work/repo", repoUrl: "https://github.com/example/public.git" },
      } } },
    });
  });

  it.each([
    ["outside the configured roots", host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "/home/other/repo", repoUrl: "https://github.com/example/public" }) })],
    ["on-disk origin differs from repoUrl", host({ onDiskRepoUrl: async () => "https://github.com/example/private" })],
    ["no on-disk origin", host({ onDiskRepoUrl: async () => null })],
    ["expected workspace differs", host()],
  ])("resolves no secret when the bind is refused: %s", async (name, fakeHost) => {
    const apiKey = vi.fn(async () => "scoped-key");
    const options = name === "expected workspace differs" ? { expectedWorkspaceId: projectWorkspaceId } : {};
    expect(await localRunRealization(started, localRunSettings(enabled), { ...fakeHost, apiKey }, options)).toBe(null);
    expect(apiKey).not.toHaveBeenCalled();
  });

  it("accepts the project workspace id the shim reports for an execution-branch bind", async () => {
    // The live smoke failure: the bind keys on the execution
    // workspace id, but PAPERCLIP_WORKSPACE_ID carries the project workspace id.
    const params = await localRunRealization(started, localRunSettings(enabled), host({
      workspace: async () => ({ projectId: "project", projectWorkspaceId, path: "/srv/work/repo", repoUrl: "https://github.com/example/public" }),
    }), { expectedWorkspaceId: projectWorkspaceId });
    expect(params).toMatchObject({
      workspace: { localPath: "/srv/work/repo", metadata: { workspaceRealizationRequest: {
        heartbeatRunId: runId, executionWorkspaceId: workspaceId, localRun: true,
        source: { localPath: "/srv/work/repo", repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId },
      } } },
    });
  });

  it("falls back to the execution workspace cwd when its path is null", async () => {
    const params = await localRunRealization(started, localRunSettings(enabled), host({
      workspace: async () => ({ projectId: "project", projectWorkspaceId, path: null, cwd: "/srv/work/repo", repoUrl: "https://github.com/example/public" }),
    }));
    expect(params).toMatchObject({ workspace: { localPath: "/srv/work/repo" } });
  });

  it.each([
    ["disabled", { ...enabled, offloadLocalRunsEnabled: false }, host(), {}, "not enabled"],
    ["outside the roots", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "/home/other/repo", repoUrl: "https://github.com/example/public" }) }), {}, "outside the configured roots"],
    ["expected workspace differs", enabled, host(), { expectedWorkspaceId: projectWorkspaceId }, "does not match"],
    ["on-disk origin differs", enabled, host({ onDiskRepoUrl: async () => "https://github.com/example/private" }), {}, "does not match"],
  ])("reports a refusal reason the caller can log: %s", async (_name, settings, fakeHost, options, reason) => {
    const reasons: string[] = [];
    expect(await localRunRealization(started, localRunSettings(settings), fakeHost, { ...options, onRefuse: (r) => reasons.push(r) })).toBe(null);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(reason);
  });

  it("binds the project workspace when the live issue shape leaves executionWorkspaceId null", async () => {
    const params = await localRunRealization(started, localRunSettings(enabled), host({
      issueWorkspaceId: async () => null,
      issueProjectWorkspace: async () => ({ id: projectWorkspaceId, projectId: "project",
        path: "/srv/work/repo", repoUrl: "https://github.com/example/public" }),
    }));
    expect(params).toMatchObject({
      companyId, environmentId, config: { maxOffloadVms: 1, apiKey: "scoped-key" },
      workspace: { localPath: "/srv/work/repo", metadata: { workspaceRealizationRequest: {
        version: 1, companyId, environmentId, heartbeatRunId: runId, executionWorkspaceId: projectWorkspaceId,
        source: { localPath: "/srv/work/repo", repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId },
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
    ["project workspace lookup fails", enabled, host({ issueWorkspaceId: async () => null,
      issueProjectWorkspace: async () => { throw new Error("projects unavailable"); } })],
    ["project workspace unknown", enabled, host({ issueWorkspaceId: async () => null,
      issueProjectWorkspace: async () => null })],
    ["project workspace not locally realized", enabled, host({ issueWorkspaceId: async () => null,
      issueProjectWorkspace: async () => ({ id: projectWorkspaceId, projectId: "p", path: null, repoUrl: null }) })],
    ["relative project workspace path", enabled, host({ issueWorkspaceId: async () => null,
      issueProjectWorkspace: async () => ({ id: projectWorkspaceId, projectId: "p", path: "repo", repoUrl: null }) })],
    ["secret resolves empty", enabled, host({ apiKey: async () => null })],
    ["no source roots configured", { ...enabled, offloadLocalSourceRoots: [] }, host()],
    ["source roots not an array", { ...enabled, offloadLocalSourceRoots: "/srv/work" }, host()],
    ["workspace path outside the source roots", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "/home/other/repo", repoUrl: "https://github.com/example/public" }) })],
    ["sibling prefix is not inside a root", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "/srv/work-evil/repo", repoUrl: "https://github.com/example/public" }) })],
    ["workspace has no repoUrl", enabled, host({ workspace: async () => ({ projectId: "p", projectWorkspaceId: null, path: "/srv/work/repo", repoUrl: null }) })],
    ["on-disk origin differs from repoUrl", enabled, host({ onDiskRepoUrl: async () => "https://github.com/example/private" })],
    ["checkout has no on-disk origin", enabled, host({ onDiskRepoUrl: async () => null })],
    ["source path does not resolve", enabled, host({ canonicalPath: async () => null })],
  ])("binds nothing when %s", async (_name, settings, fakeHost) => {
    expect(await localRunRealization(started, localRunSettings(settings), fakeHost)).toBe(null);
  });

  it("reads the origin from a linked worktree's common git config, and refuses a symlinked config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "boat-origin-"));
    try {
      const common = path.join(root, "main", ".git");
      const worktreeGit = path.join(common, "worktrees", "wt");
      await mkdir(worktreeGit, { recursive: true });
      await writeFile(path.join(common, "config"), '[remote "origin"]\n\turl = https://github.com/example/public\n');
      await writeFile(path.join(worktreeGit, "commondir"), "../..\n");
      const checkout = path.join(root, "checkout");
      await mkdir(checkout);
      await writeFile(path.join(checkout, ".git"), `gitdir: ${worktreeGit}\n`);
      expect(await readGitOriginUrl(checkout)).toBe("https://github.com/example/public");
      const plain = path.join(root, "plain");
      await mkdir(path.join(plain, ".git"), { recursive: true });
      await symlink(path.join(common, "config"), path.join(plain, ".git", "config"));
      expect(await readGitOriginUrl(plain)).toBe(null);
      expect(await readGitOriginUrl(root)).toBe(null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  const gitOrigin = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;
  // Live company config. Each request grants its own exact, short-lived
  // operator policy by mutating this object; the host-owned claim is never cleared.
  let current: Record<string, unknown> = {};
  async function setup(config: Record<string, unknown>, configGet?: () => Promise<Record<string, unknown>>) {
    current = { offloadExecutorEnabled: true, ...config };
    dir = await mkdtemp(path.join(tmpdir(), "boat-local-run-"));
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "config"), gitOrigin("https://github.com/example/public"));
    const harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: workspaceId, executionRunId: runId }]]),
      workspaces: new Map([[workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null, path: dir, cwd: dir }]]),
    });
    harness.secrets.set(secretId, "scoped-key");
    await plugin.definition.setup({ ...harness.ctx, config: { get: configGet ?? (async () => current) } } as never);
    return harness;
  }
  const grant = (commandId: string, who: { run?: string; ws?: string; agent?: string } = {}) => {
    const issued = Date.now() - 1000;
    current.offloadAdmission = { version: 1, companyId, agentId: who.agent ?? agentId, runId: who.run ?? runId,
      executionWorkspaceId: who.ws ?? workspaceId, commandId,
      issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 60 * 60_000).toISOString() };
  };
  // Host-owned identity: authenticatedRunId is supplied by the host, never derived from the generic run id.
  const call = (o: { run?: string; auth?: string | null; agent?: string; ws?: string; cmd?: string; argv?: string[]; dryRun?: boolean } = {}) =>
    plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId,
      actor: { actorType: "agent", actorId: o.agent ?? agentId, agentId: o.agent ?? agentId, runId: o.run ?? runId,
        authenticatedRunId: o.auth === undefined ? (o.run ?? runId) : o.auth }, params: {}, query: {},
      body: { version: 1, commandId: o.cmd ?? randomUUID(), executionWorkspaceId: o.ws ?? workspaceId, argv: o.argv ?? ["fmt"], cwdRelative: ".", env: {},
        queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: o.dryRun ?? false } } as never);
  // The real, admitted bind trigger: argv ["fmt"] is a deterministic never-started
  // refusal after the bind and before any consume or dispatch, so it can repeat.
  const admittedBind = (run: string = runId, ws: string = workspaceId, cmd: string = randomUUID()) => {
    grant(cmd, { run, ws });
    return call({ run, ws, cmd });
  };
  const refusedAfterBind = (response: Awaited<ReturnType<typeof call>>) =>
    response.status === 503 && JSON.stringify(response.body).includes("incompatible workload");
  // Pre-bind through the real admitted path, then classify with a read-only dry run. An unsuccessful
  // bind (403, or 503 for an unbound workspace) is returned as is, never masked as success.
  const exec = async (actorRunId: string, execWorkspaceId: string = workspaceId) => {
    const cmd = randomUUID();
    const bound = await admittedBind(actorRunId, execWorkspaceId, cmd);
    if (!refusedAfterBind(bound)) return bound;
    return call({ run: actorRunId, ws: execWorkspaceId, cmd, argv: ["test", "--locked"], dryRun: true });
  };
  const noClaims = (harness: Awaited<ReturnType<typeof setup>>) =>
    [...harness.state.keys()].filter((key) => key.includes("boat-offload-admission"));

  it("admits the started run's own workspace after agent.run.started, and only that run", async () => {
    const harness = await setup(enabled);
    expect((await exec(runId)).status).toBe(403);
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(200);
    expect((await exec(randomUUID())).status).toBe(403);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(true);
    // Binding and dry-run classification never consumed a grant.
    expect(noClaims(harness)).toEqual([]);
  });

  it("agent.run.started alone resolves no secret and binds nothing", async () => {
    const harness = await setup(enabled);
    let resolutions = 0;
    const originalResolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref: { secretId?: string } | null) => { resolutions += 1; return originalResolve(ref); };
    try {
      await harness.emit("agent.run.started", started);
      expect(resolutions).toBe(0);
      expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    } finally {
      harness.ctx.secrets.resolve = originalResolve;
    }
  });

  it("a generic header run without authenticatedRunId, a wrong pinned tuple or a dry run resolves no secret and binds nothing", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    let resolutions = 0;
    const originalResolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref: { secretId?: string } | null) => { resolutions += 1; return originalResolve(ref); };
    const manager = (await import("./plugin.js")).currentManager();
    try {
      const cmd = randomUUID();
      grant(cmd);
      // Exact grant, but only the unsigned generic run id: no verified run.
      expect((await call({ cmd, auth: null })).status).toBe(403);
      expect((await call({ cmd, auth: randomUUID() })).status).toBe(403);
      // Verified run, but each element of the pinned tuple is wrong in turn.
      expect((await call({ cmd: randomUUID() })).status).toBe(403);
      expect((await call({ cmd, ws: projectWorkspaceId })).status).toBe(403);
      grant(cmd, { agent: randomUUID() });
      expect((await call({ cmd })).status).toBe(403);
      grant(cmd, { run: randomUUID() });
      expect((await call({ cmd })).status).toBe(403);
      grant(cmd, { ws: randomUUID() });
      expect((await call({ cmd })).status).toBe(403);
      // An exact grant on a dry run is read-only: it does not bind or resolve a secret.
      grant(cmd);
      expect((await call({ cmd, argv: ["test", "--locked"], dryRun: true })).status).toBe(503);
      expect(resolutions).toBe(0);
      expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
      expect(noClaims(harness)).toEqual([]);
      // Control: the same exact grant on a real request does bind.
      grant(cmd);
      expect(refusedAfterBind(await call({ cmd }))).toBe(true);
      expect(resolutions).toBe(1);
      expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(true);
    } finally {
      harness.ctx.secrets.resolve = originalResolve;
    }
  });

  it("answers under the project workspace id the shim reports for an execution-branch bind", async () => {
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    await harness.emit("agent.run.started", started);
    const response = await exec(runId, projectWorkspaceId);
    const bound = harness.logs.find((entry) => entry.message === "boat: bound local run for offload");
    // Both ids are logged: binds key on the execution workspace id, but the
    // shim (and later executor refusal logs) report the project workspace id.
    expect(bound?.meta).toMatchObject({ runId, workspaceId, projectWorkspaceId });
    expect(response.status).toBe(200);
    // Remote classification under the alias, then the executor gate answers:
    // exact-run admission needs the executor flag, so the next gate (guest transport) refuses.
    expect(response.body).toMatchObject({ mode: "local" });
    expect((await exec(runId, workspaceId)).status).toBe(200);
    const manager = (await import("./plugin.js")).currentManager();
    expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(true);
    expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(true);
    // A workspace id the host never named for this run still refuses.
    expect((await exec(runId, randomUUID())).status).toBe(503);
  });

  it("completes the bind on request when the started bind registered only the execution id", async () => {
    const harness = await setup(enabled);
    // The first admitted bind sees no project workspace link yet: primary id only.
    await harness.emit("agent.run.started", started);
    expect(refusedAfterBind(await admittedBind())).toBe(true);
    const manager = (await import("./plugin.js")).currentManager();
    expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(true);
    expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(false);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    expect((await exec(runId, projectWorkspaceId)).status).toBe(200);
    expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(true);
    // Probing afterwards with random ids still spends no secret resolution.
    let resolutions = 0;
    const originalResolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref: { secretId?: string } | null) => { resolutions += 1; return originalResolve(ref); };
    try {
      for (let i = 0; i < 10; i += 1) expect((await exec(runId, randomUUID())).status).toBe(503);
      expect(resolutions).toBe(0);
    } finally {
      harness.ctx.secrets.resolve = originalResolve;
    }
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

  it("a terminal event during a slow admitted bind leaves no binding", async () => {
    const harness = await setup(enabled);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await harness.emit("agent.run.started", started);
    const original = harness.ctx.issues.get;
    harness.ctx.issues.get = async (id: string) => { await gate; return original(id); };
    const pending = admittedBind();
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
    await harness.emit("agent.run.started", started);
    const pending = admittedBind();
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
    await harness.emit("agent.run.started", { companyId, payload: { runId: otherRun, issueId, agentId } });
    expect(refusedAfterBind(await admittedBind())).toBe(true);
    expect(refusedAfterBind(await admittedBind(otherRun))).toBe(true);
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
      await harness.emit("agent.run.started", started);
      const pending = admittedBind();
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

  it("a racing whole-run realization without the project alias still claims the alias the local bind registered", async () => {
    // The local bind's workspace metadata carries the project workspace id,
    // but the racing whole-run payload omits it: the alias record the local
    // write just made must end up serving the whole-run source in both
    // stores, not the local checkout.
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-race-alias-"));
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
      await harness.emit("agent.run.started", started);
      const pending = admittedBind();
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
      const saved = [...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces"))
        .map(([, value]) => value as { workspaceId?: string; workspace?: { path?: string } });
      expect(saved.find((record) => record.workspaceId === projectWorkspaceId)?.workspace?.path).toBe(nativeSource);
      expect(saved.find((record) => record.workspaceId === workspaceId)?.workspace?.path).toBe(nativeSource);
      const manager = (await import("./plugin.js")).currentManager();
      expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(true);
      expect((await exec(runId, projectWorkspaceId)).status).toBe(200);
    } finally {
      harness.ctx.state.set = originalSet;
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  // State writes in the two restoration-race tests below, in order: the local
  // record under both ids (1-2), the whole-run realization's own persisted
  // record and alias claim (3-4), then the restoration write inside
  // rememberLocalRun (5). Gating write 5 holds the restoration in flight.
  const gateRestorationWrites = (harness: Awaited<ReturnType<typeof setup>>) => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstReached!: () => void;
    const firstWriting = new Promise<void>((resolve) => { firstReached = resolve; });
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    let restoreReached!: () => void;
    const restoreWriting = new Promise<void>((resolve) => { restoreReached = resolve; });
    const originalSet = harness.ctx.state.set;
    let writes = 0;
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces") {
        writes += 1;
        if (writes === 1) { firstReached(); await firstGate; }
        if (writes === 5) { restoreReached(); await restoreGate; }
      }
      return originalSet(input, value);
    };
    return { firstWriting, restoreWriting, releaseFirst, releaseRestore,
      restore: () => { harness.ctx.state.set = originalSet; } };
  };
  const realizeWholeRun = (source: string, projectId: string) => {
    const nativeEnv = randomUUID();
    return plugin.definition.onEnvironmentRealizeWorkspace!({ driverKey: "boat", companyId, environmentId: nativeEnv,
      config: { apiKey: "native-key" }, lease: { providerLeaseId: null },
      workspace: { localPath: source, metadata: { workspaceRealizationRequest: { version: 1, companyId,
        environmentId: nativeEnv, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
        source: { localPath: source, repoUrl: null, projectId, projectWorkspaceId: null } } } } } as never);
  };

  it("a terminal event while the whole-run restoration is written leaves no binding under either id", async () => {
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-restore-terminal-"));
    const gates = gateRestorationWrites(harness);
    try {
      await harness.emit("agent.run.started", started);
      const pending = admittedBind();
      await gates.firstWriting;
      const realizing = realizeWholeRun(nativeSource, "native-project");
      await new Promise((resolve) => setTimeout(resolve, 10));
      gates.releaseFirst();
      await gates.restoreWriting;
      const ending = harness.emit("agent.run.finished", { companyId, payload: { runId, issueId } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      gates.releaseRestore();
      await Promise.all([pending, realizing, ending]);
      const manager = (await import("./plugin.js")).currentManager();
      expect(manager.hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
      expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(false);
      expect((await exec(runId)).status).toBe(403);
      expect((await exec(runId, projectWorkspaceId)).status).toBe(403);
    } finally {
      gates.restore();
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  it("a newer whole-run realization landing during the restoration is the one both stores serve", async () => {
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    const sourceA = await mkdtemp(path.join(tmpdir(), "boat-native-restore-a-"));
    const sourceB = await mkdtemp(path.join(tmpdir(), "boat-native-restore-b-"));
    const gates = gateRestorationWrites(harness);
    try {
      await harness.emit("agent.run.started", started);
      const pending = admittedBind();
      await gates.firstWriting;
      const realizingA = realizeWholeRun(sourceA, "native-project-a");
      await new Promise((resolve) => setTimeout(resolve, 10));
      gates.releaseFirst();
      await gates.restoreWriting;
      const realizingB = realizeWholeRun(sourceB, "native-project-b");
      await new Promise((resolve) => setTimeout(resolve, 10));
      gates.releaseRestore();
      await Promise.all([pending, realizingA, realizingB]);
      const saved = [...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces"))
        .map(([, value]) => value as { workspaceId?: string; workspace?: { path?: string } });
      expect(saved.find((record) => record.workspaceId === workspaceId)?.workspace?.path).toBe(sourceB);
      expect(saved.find((record) => record.workspaceId === projectWorkspaceId)?.workspace?.path).toBe(sourceB);
      // hasOffloadBinding is boolean, so read the runtime binding's source
      // directly: it must be B under both ids, not the stale captured A.
      const manager = (await import("./plugin.js")).currentManager();
      const runtime = manager as unknown as { nativeOffload: { bindings: Map<string, { source: string }> } };
      expect(runtime.nativeOffload.bindings.get(JSON.stringify([companyId, runId, workspaceId]))?.source).toBe(sourceB);
      expect(runtime.nativeOffload.bindings.get(JSON.stringify([companyId, runId, projectWorkspaceId]))?.source).toBe(sourceB);
      expect((await exec(runId, projectWorkspaceId)).status).toBe(200);
    } finally {
      gates.restore();
      await rm(sourceA, { recursive: true, force: true });
      await rm(sourceB, { recursive: true, force: true });
    }
  });

  it("a whole-run realization without the project alias supersedes a completed local bind under the alias in both stores", async () => {
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId, path: dir, cwd: dir });
    await harness.emit("agent.run.started", started);
    expect((await exec(runId, projectWorkspaceId)).status).toBe(200);
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-after-local-"));
    const nativeEnv = randomUUID();
    try {
      await plugin.definition.onEnvironmentRealizeWorkspace!({ driverKey: "boat", companyId, environmentId: nativeEnv,
        config: { apiKey: "native-key" }, lease: { providerLeaseId: null },
        workspace: { localPath: nativeSource, metadata: { workspaceRealizationRequest: { version: 1, companyId,
          environmentId: nativeEnv, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
          source: { localPath: nativeSource, repoUrl: null, projectId: "native-project", projectWorkspaceId: null } } } } } as never);
      const saved = [...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces"))
        .map(([, value]) => value as { workspaceId?: string; workspace?: { path?: string } });
      expect(saved.find((record) => record.workspaceId === projectWorkspaceId)?.workspace?.path).toBe(nativeSource);
      expect(saved.find((record) => record.workspaceId === workspaceId)?.workspace?.path).toBe(nativeSource);
      const manager = (await import("./plugin.js")).currentManager();
      expect(manager.hasOffloadBinding(companyId, runId, projectWorkspaceId)).toBe(true);
      expect((await exec(runId, projectWorkspaceId)).status).toBe(200);
      expect((await exec(runId, workspaceId)).status).toBe(200);
    } finally {
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  it("a failed state write on the first offload request falls back locally and stays retryable", async () => {
    const harness = await setup(enabled);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null });
    await harness.emit("agent.run.started", started);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: workspaceId });
    const originalSet = harness.ctx.state.set;
    harness.ctx.state.set = async (input: { namespace?: string; scopeKind: string; stateKey: string }, value: unknown) => {
      if (input.namespace === "boat-offload-workspaces") throw new Error("state store unavailable");
      return originalSet(input, value);
    };
    const fallback = await exec(runId);
    expect(fallback.status).toBe(503);
    expect(fallback.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    harness.ctx.state.set = originalSet;
    expect((await exec(runId)).status).toBe(200);
  });

  it("accepts the live shape: a null execution workspace id bound on the project workspace id", async () => {
    const harness = await setup(enabled);
    harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null });
    await harness.emit("agent.run.started", started);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    harness.projectWorkspaces.set(issueId, { id: projectWorkspaceId, projectId: "project",
      path: harness.workspaces.get(workspaceId)!.path, repoUrl: "https://github.com/example/public" });
    const response = await exec(runId, projectWorkspaceId);
    expect(response.status).toBe(200);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(true);
    // The started run's sibling still has no authority.
    expect((await exec(randomUUID())).status).toBe(403);
  });

  it("a config read failure falls the first offload request back locally and the retry recovers", async () => {
    let failing = true;
    let reads = 0;
    const harness = await setup(enabled, async () => { reads += 1; if (failing) throw new Error("config unavailable"); return current; });
    // The telemetry snapshot fails closed; dispatch still retries independently.
    await harness.emit("agent.run.started", started);
    const closed = await exec(runId);
    expect(reads).toBeGreaterThan(0);
    // Closed to remote work, but fallback-safe: a 403 would be an auth exit in the shim.
    expect(closed.status).toBe(503);
    expect(closed.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    failing = false;
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
      expect(await manager.rememberLocalRun((await localRunRealization(started, localRunSettings(enabled), host()))!)).toBe(false);
      expect(refusedAfterBind(await admittedBind())).toBe(true);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
      const saved = [...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces"))
        .map(([, value]) => value as { workspace?: { path?: string } });
      expect(saved.map((record) => record.workspace?.path)).toEqual([nativeSource]);
    } finally {
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  it("never replaces a whole-run realization under its project workspace alias", async () => {
    const harness = await setup(enabled);
    const nativeSource = await mkdtemp(path.join(tmpdir(), "boat-native-alias-"));
    const nativeEnv = randomUUID();
    try {
      await plugin.definition.onEnvironmentRealizeWorkspace!({ driverKey: "boat", companyId, environmentId: nativeEnv,
        config: { apiKey: "native-key" }, lease: { providerLeaseId: null },
        workspace: { localPath: nativeSource, metadata: { workspaceRealizationRequest: { version: 1, companyId,
          environmentId: nativeEnv, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
          source: { localPath: nativeSource, repoUrl: null, projectId: "native-project", projectWorkspaceId } } } } } as never);
      // The issue now presents without an execution workspace, so the started
      // local bind takes the project branch and keys on the alias alone.
      harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: null });
      harness.projectWorkspaces.set(issueId, { id: projectWorkspaceId, projectId: "project",
        path: harness.workspaces.get(workspaceId)!.path, repoUrl: "https://github.com/example/public" });
      await harness.emit("agent.run.started", started);
      // The request-time bind would skip an already-bound id, so also drive the project-branch bind directly.
      const manager = (await import("./plugin.js")).currentManager();
      expect(await manager.rememberLocalRun((await localRunRealization(started, localRunSettings(enabled), host({
        issueWorkspaceId: async () => null,
        issueProjectWorkspace: async () => ({ id: projectWorkspaceId, projectId: "project", path: dir, repoUrl: "https://github.com/example/public" }),
      })))!)).toBe(false);
      expect(refusedAfterBind(await admittedBind(runId, projectWorkspaceId))).toBe(true);
      expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
      const saved = [...harness.state.entries()].filter(([key]) => key.includes("boat-offload-workspaces"))
        .map(([, value]) => value as { workspaceId?: string; workspace?: { path?: string } });
      expect(saved.find((record) => record.workspaceId === projectWorkspaceId)?.workspace?.path).toBe(nativeSource);
      expect(saved.find((record) => record.workspaceId === workspaceId)?.workspace?.path).toBe(nativeSource);
    } finally {
      await rm(nativeSource, { recursive: true, force: true });
    }
  });

  const workspaceBindings = (harness: Awaited<ReturnType<typeof setup>>) =>
    [...harness.state.keys()].filter((key) => key.includes("boat-offload-workspaces"));
  const restart = async (harness: Awaited<ReturnType<typeof setup>>) => {
    await plugin.definition.onShutdown?.();
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => current } } as never);
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
    expect(workspaceBindings(harness)).toEqual([]);
    expect(refusedAfterBind(await admittedBind())).toBe(true);
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

  it("an agent-rewritten workspace path outside the configured roots gets no binding, allowlisted repoUrl or not", async () => {
    const harness = await setup(enabled);
    harness.workspaces.set(workspaceId, { repoUrl: "https://github.com/example/public", projectId: "project",
      projectWorkspaceId: null, path: "/etc", cwd: "/etc" });
    await harness.emit("agent.run.started", started);
    expect(refusedAfterBind(await admittedBind())).toBe(false);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
    expect([403, 503]).toContain((await exec(runId)).status);
  });

  it("a checkout whose on-disk origin differs from the workspace repoUrl gets no binding", async () => {
    const harness = await setup(enabled);
    await writeFile(path.join(dir!, ".git", "config"), gitOrigin("https://github.com/example/private"));
    await harness.emit("agent.run.started", started);
    expect(refusedAfterBind(await admittedBind())).toBe(false);
    expect(harness.logs.some((entry) => entry.message === "boat: bound local run for offload")).toBe(false);
    expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
    expect([403, 503]).toContain((await exec(runId)).status);
  });

  it("after one bind, 50 offload_exec calls with random workspace ids resolve no further secret", async () => {
    const harness = await setup(enabled);
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(200);
    let resolutions = 0;
    const originalResolve = harness.ctx.secrets.resolve;
    harness.ctx.secrets.resolve = async (ref: { secretId?: string } | null) => { resolutions += 1; return originalResolve(ref); };
    try {
      for (let i = 0; i < 50; i += 1) {
        expect((await exec(runId, randomUUID())).status).not.toBe(200);
      }
      expect(resolutions).toBe(0);
    } finally {
      harness.ctx.secrets.resolve = originalResolve;
    }
  });

  it("leaves local runs unbound while the setting is off", async () => {
    const harness = await setup({});
    await harness.emit("agent.run.started", started);
    expect((await exec(runId)).status).toBe(503);
    expect((await import("./plugin.js")).currentManager().hasOffloadBinding(companyId, runId, workspaceId)).toBe(false);
  });
});
