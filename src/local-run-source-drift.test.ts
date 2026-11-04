import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { createFakeContext } from "./test-support/harness.js";
import { durationKey, normalizeSignature } from "./offload/duration-history.js";
import { resetReportBudgets } from "./offload/routes.js";
import { NativeOffloadWorkspaces } from "./offload/workspaces.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";

const commands = [
  { tool: "node", runner: "npm", argv: ["test"], profile: "node-public-1" },
  { tool: "python", runner: "pytest", argv: ["tests"], profile: "python-public-1" },
];
const companyId = randomUUID();
const runId = randomUUID();
const issueId = randomUUID();
const agentId = randomUUID();
const aliasId = randomUUID();
const started = { companyId, payload: { runId, issueId, agentId } };

describe("unbound exact-run duration source snapshots", () => {
  let dir: string;
  let harness: ReturnType<typeof createFakeContext>;
  let sources: { id: string; root: string; repo: string }[];
  let effects: ReturnType<typeof vi.spyOn>[];
  let startedEvent: typeof started & { occurredAt: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    resetReportBudgets();
    dir = await mkdtemp(path.join(tmpdir(), "boat-duration-source-"));
    sources = [
      { id: randomUUID(), root: path.join(dir, "a"), repo: "https://github.com/example/a" },
      { id: randomUUID(), root: path.join(dir, "b"), repo: "https://github.com/example/b" },
    ];
    for (const source of sources) {
      await mkdir(path.join(source.root, ".git"), { recursive: true });
      await writeFile(path.join(source.root, ".git", "config"), `[remote "origin"]\nurl = ${source.repo}\n`);
    }
    harness = createFakeContext({
      issues: new Map([[issueId, { status: "in_progress", executionWorkspaceId: sources[0]!.id, executionRunId: runId }]]),
      workspaces: new Map(sources.map((source) => [source.id, {
        projectId: "project", projectWorkspaceId: aliasId, path: source.root, cwd: source.root, repoUrl: source.repo,
      }])),
    });
    harness.ctx.config.get = async () => ({ offloadLocalRunsEnabled: true, offloadLocalSourceRoots: [dir],
      offloadExecutorEnabled: false, offloadGuestTransportEnabled: false });
    const executor = vi.fn(async () => { throw new Error("unexpected executor resolution"); });
    setManagerOverridesForTests({ offloadExecutor: executor });
    await plugin.definition.setup(harness.ctx as never);
    vi.setSystemTime(Date.now() + 1);
    startedEvent = { ...started, occurredAt: new Date().toISOString() };
    const manager = currentManager();
    effects = [executor, vi.spyOn(harness.ctx.secrets, "resolve"), vi.spyOn(manager, "rememberLocalRun"),
      vi.spyOn(manager, "rememberOffloadWorkspace"), vi.spyOn(manager, "acquire"), vi.spyOn(manager, "resumeLease"),
      vi.spyOn(manager, "probe"), vi.spyOn(manager, "realizeWorkspace"),
      vi.spyOn(NativeOffloadWorkspaces.prototype, "remember"), vi.spyOn(SshOffloadRuntime.prototype, "remember"),
      vi.spyOn(SshOffloadRuntime.prototype, "resolve")];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
  });

  afterEach(async () => {
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const id of [aliasId, ...sources.map((source) => source.id)]) {
      expect(currentManager().hasOffloadBinding(companyId, runId, id)).toBe(false);
    }
    expect([...harness.state.keys()].filter((key) => key.includes("boat-offload-workspaces")
      || key.includes("boat-offload-admission") || key.startsWith("instance|"))).toEqual([]);
    await plugin.definition.onShutdown?.();
    setManagerOverridesForTests({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const start = () => harness.emit("agent.run.started", startedEvent);
  const report = (command = commands[0]!, id: string = aliasId) => plugin.definition.onApiRequest!({
    routeKey: "offload_report", companyId,
    actor: { actorType: "agent", actorId: agentId, agentId, runId }, params: {}, query: {},
    body: { executionWorkspaceId: id, tool: command.tool, runner: command.runner, argv: command.argv, durationSeconds: 120 },
  } as never);
  const history = (command: typeof commands[number], sourceIndex: number) => harness.ctx.state.get({
    scopeKind: "company", scopeId: companyId, namespace: "boat-offload",
    stateKey: durationKey(`repo:${sources[sourceIndex]!.repo}`, command.profile, normalizeSignature(command.tool, command.runner, command.argv)),
  });
  const moveIssue = (id: string | null, run = runId) => harness.issues.set(issueId, {
    status: "in_progress", executionWorkspaceId: id, executionRunId: run,
  });
  const projectSource = (index: number) => harness.projectWorkspaces.set(issueId, {
    id: aliasId, projectId: "project", path: sources[index]!.root, repoUrl: sources[index]!.repo,
  });
  const expectRefusal = async (command = commands[0]!, id: string = aliasId) => {
    const before = structuredClone([...harness.state.entries()]);
    expect((await report(command, id)).status).toBe(403);
    expect([...harness.state.entries()]).toEqual(before);
  };
  const pauseWorkspaceRead = () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    const original = harness.ctx.executionWorkspaces.get;
    harness.ctx.executionWorkspaces.get = async (id) => { reached(); await gate; return original(id); };
    return { release, reading };
  };

  it.each(commands.flatMap((command) => ["alias", "primary"].map((idKind) => ({ ...command, idKind }))))(
    "pins $tool $idKind completion to A after the issue moves to B with the same alias", async (command) => {
      await start();
      moveIssue(sources[1]!.id);
      // Duplicate host delivery must not capture B under the same run key.
      await start();
      expect((await report(command, command.idKind === "alias" ? aliasId : sources[0]!.id)).status).toBe(200);
      expect(await history(command, 0)).toEqual([{ seconds: 120, at: expect.any(Number) }]);
      expect(await history(command, 1)).toBeNull();
      await expectRefusal(command, sources[1]!.id);
    },
  );

  it.each(commands)("keeps $tool attribution to A when both the issue workspace and current run drift", async (command) => {
    await start();
    moveIssue(sources[1]!.id, randomUUID());
    expect((await report(command)).status).toBe(200);
    expect(await history(command, 0)).toHaveLength(1);
    expect(await history(command, 1)).toBeNull();
  });

  it.each(commands)("supports the stable project-only $tool source and pins it across primary drift", async (command) => {
    moveIssue(null);
    projectSource(0);
    await start();
    expect((await report(command)).status).toBe(200);
    projectSource(1);
    moveIssue(sources[1]!.id, randomUUID());
    expect((await report(command)).status).toBe(200);
    expect(await history(command, 0)).toHaveLength(2);
    expect(await history(command, 1)).toBeNull();
  });

  it.each(commands)("refuses $tool when A's workspace row is rewritten to B even if disk and row agree", async (command) => {
    await start();
    harness.workspaces.set(sources[0]!.id, { ...harness.workspaces.get(sources[1]!.id)! });
    await expectRefusal(command);
    expect(await history(command, 0)).toBeNull();
    expect(await history(command, 1)).toBeNull();
  });

  it.each(["missing workspace", "wrong run", "unknown run", "config failure", "owner lookup failure"])("cannot reconstruct a snapshot after %s at start", async (reason) => {
    const configGet = harness.ctx.config.get;
    const stateGet = harness.ctx.state.get;
    if (reason === "missing workspace") moveIssue(null);
    if (reason === "wrong run") moveIssue(sources[0]!.id, randomUUID());
    if (reason === "unknown run") harness.issues.set(issueId, { status: "in_progress", executionWorkspaceId: sources[0]!.id });
    if (reason === "config failure") harness.ctx.config.get = async () => { throw new Error("unavailable"); };
    if (reason === "owner lookup failure") harness.ctx.state.get = async () => { throw new Error("unavailable"); };
    await start();
    moveIssue(sources[1]!.id);
    harness.ctx.config.get = configGet;
    harness.ctx.state.get = stateGet;
    await start();
    for (const command of commands) {
      await expectRefusal(command);
      await expectRefusal(command, sources[1]!.id);
    }
  });

  it.each(["persisted owner", "failed owner write", "terminal cleanup"])("does not rehydrate telemetry source after restart and start replay with %s", async (reason) => {
    const stateSet = harness.ctx.state.set;
    if (reason === "failed owner write") harness.ctx.state.set = async () => { throw new Error("unavailable"); };
    await start();
    harness.ctx.state.set = stateSet;
    if (reason === "terminal cleanup") await harness.emit("agent.run.finished", { companyId, payload: { runId } });
    await plugin.definition.onShutdown?.();
    moveIssue(sources[1]!.id);
    // Rebuild event subscribers like a real process restart, retaining only host state.
    const fresh = createFakeContext({ issues: harness.issues, workspaces: harness.workspaces });
    fresh.ctx.state = harness.ctx.state;
    fresh.state = harness.state;
    fresh.ctx.config.get = harness.ctx.config.get;
    harness = fresh;
    vi.setSystemTime(Date.now() + 1);
    await plugin.definition.setup(harness.ctx as never);
    effects.push(vi.spyOn(harness.ctx.secrets, "resolve"));
    await start();
    for (const command of commands) await expectRefusal(command);
  });

  it.each(["old", "same millisecond", "missing", "invalid", "future"])("refuses a %s start timestamp without reconstructing a source", async (kind) => {
    const at = kind === "old" ? Date.now() - 2 : kind === "same millisecond" ? Date.now() - 1
      : kind === "future" ? Date.now() + 1 : kind === "invalid" ? "not-a-date" : undefined;
    startedEvent.occurredAt = typeof at === "number" ? new Date(at).toISOString() : at as string;
    await start();
    for (const command of commands) await expectRefusal(command);
  });

  it.each(["workspace", "run"])("refuses a snapshot if the issue's %s changes during capture", async (changed) => {
    const gate = pauseWorkspaceRead();
    const pending = start();
    await gate.reading;
    moveIssue(changed === "workspace" ? sources[1]!.id : sources[0]!.id, changed === "run" ? randomUUID() : runId);
    gate.release();
    await pending;
    for (const command of commands) await expectRefusal(command);
  });

  it.each(["agent.run.finished", "agent.run.failed", "agent.run.cancelled"])("does not revive a source when %s arrives during capture", async (terminal) => {
    const gate = pauseWorkspaceRead();
    const pending = start();
    await gate.reading;
    await harness.emit(terminal, { companyId, payload: { runId } });
    gate.release();
    await pending;
    moveIssue(sources[1]!.id);
    await start();
    for (const command of commands) await expectRefusal(command);
  });
});
