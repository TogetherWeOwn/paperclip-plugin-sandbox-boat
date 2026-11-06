// Contract tests for the local-run offload binding against stock Paperclip
// 2026.1023.0 (1b4c803). The real worker runs over JSON-RPC behind the SDK's
// createHostClientHandlers, which is the capability gate the host itself uses
// (server/dist/app.js buildHostHandlers). The host services below return
// exactly what that host version builds; each fixture names its source so a
// host upgrade can be re-checked line by line:
//   1. scoped route input:  server/dist/routes/plugins.js router.use("/plugins/:pluginId/api")
//      company resolution:  routes/plugins.js resolveScopedApiCompanyId
//      agent run id:        middleware/auth.js (JWT: signed run_id; agent key: X-Paperclip-Run-Id header)
//   2. run started event:   services/heartbeat/run-lifecycle.js publishRunLifecyclePluginEventData
//      invocation scope:    services/plugin-worker-manager.js deriveInvocationScope (onEvent -> event.companyId)
//   3. execution workspace: services/plugin-host-services.js toPluginExecutionWorkspaceMetadata
//   4. secret ref:          services/plugin-secrets-handler.js resolve (binding lookup by configPath),
//      bindings written by routes/plugins.js config save (extractSecretRefBindingsFromConfig)
//   5. manifest:            services/plugin-capability-validator.js validateManifestCapabilities
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { envBindingSecretRefSchema, pluginManifestV1Schema } from "@paperclipai/shared";
import { createHostClientHandlers, getRequiredCapability, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import type { HostServices, PluginCapability } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "./manifest.js";
import plugin from "./plugin.js";
import { resetReportBudgets } from "./offload/routes.js";

const TIMEOUT = 20_000;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();
const runId = randomUUID();
const issueId = randomUUID();
const workspaceId = randomUUID();
const environmentId = randomUUID();
const secretId = randomUUID();
const commandId = randomUUID();
const issuedAt = Date.now() - 60_000;
const config = {
  // Operator-issued exact-run grant. Stock 2026.1023.0 still cannot admit it:
  // it supplies no authenticated run identity and no atomic state create.
  offloadExecutorEnabled: true,
  offloadAdmission: { version: 1, companyId, agentId, runId, executionWorkspaceId: workspaceId, commandId,
    issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 60 * 60_000).toISOString() },
  offloadLocalRunsEnabled: true,
  offloadLocalEnvironmentId: environmentId,
  offloadLocalApiKeySecretRef: { type: "secret_ref", secretId },
  offloadLocalSourceRoots: [tmpdir()],
  offloadLocalDriverConfig: { maxOffloadVms: 1 },
};

/** services/heartbeat/run-lifecycle.js publishRunLifecyclePluginEventData, status "running". */
function runStartedEvent(run: { companyId: string; runId: string; agentId: string; issueId: string | null }) {
  vi.setSystemTime(Date.now() + 1);
  return {
    eventId: randomUUID(), eventType: "agent.run.started", occurredAt: new Date().toISOString(),
    actorId: run.agentId, actorType: "agent", entityId: run.runId, entityType: "heartbeat_run", companyId: run.companyId,
    payload: {
      runId: run.runId, agentId: run.agentId, status: "running", invocationSource: "assignment", triggerDetail: null,
      error: null, errorCode: null, issueId: run.issueId, startedAt: new Date().toISOString(), finishedAt: null,
    },
  };
}

/** routes/plugins.js scoped API input for an auth:"agent" route without companyResolution. */
function scopedRouteInput(route: { routeKey: string }, actor: { agentId: string; companyId: string; runId: string | null }, body: unknown) {
  return {
    routeKey: route.routeKey, method: "POST", path: "/offload/exec", params: {}, query: {}, body,
    actor: { actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, userId: null, runId: actor.runId },
    companyId: actor.companyId,
    headers: {},
  };
}

/** services/plugin-host-services.js toPluginExecutionWorkspaceMetadata over an execution_workspaces row. */
function toPluginExecutionWorkspaceMetadata(row: Record<string, unknown>) {
  return {
    id: row.id, companyId: row.companyId, projectId: row.projectId, projectWorkspaceId: row.projectWorkspaceId,
    path: row.cwd ?? row.providerRef, cwd: row.cwd, repoUrl: row.repoUrl, baseRef: row.baseRef,
    branchName: row.branchName, providerType: row.providerType, providerMetadata: null,
  };
}

interface HostCall { method: string; params: Record<string, unknown>; scope: string | null }

/** Minimal stand-in for plugin-worker-manager: invocation scopes, JSON-RPC framing, SDK capability gate. */
function startHost(source: string, options: { bindings?: Array<{ secretId: string; configPath: string; versionSelector: string }> } = {}) {
  const toWorker = new PassThrough();
  const fromWorker = new PassThrough();
  const worker = startWorkerRpcHost({ plugin, stdin: toWorker, stdout: fromWorker, rpcTimeoutMs: 5000 });
  const calls: HostCall[] = [];
  const logs: string[] = [];
  const state = new Map<string, unknown>();
  const invocations = new Map<string, string>();
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  let nextId = 1;
  const issues = new Map<string, Record<string, unknown>>([[issueId, { id: issueId, companyId, status: "in_progress", executionWorkspaceId: workspaceId, executionRunId: runId }]]);
  const workspaceRows = new Map<string, Record<string, unknown>>([[workspaceId, {
    id: workspaceId, companyId, projectId: randomUUID(), projectWorkspaceId: randomUUID(), cwd: source, providerRef: null,
    repoUrl: "https://github.com/example/public", baseRef: "main", branchName: "two-190", providerType: "git_worktree",
  }]]);
  // Written at config save: routes/plugins.js extractSecretRefBindingsFromConfig keys each ref by its config path.
  const bindings = options.bindings ?? [{ secretId, configPath: "offloadLocalApiKeySecretRef", versionSelector: "latest" }];
  const stateKey = (p: Record<string, unknown>) => JSON.stringify([p.scopeKind, p.scopeId ?? null, p.namespace ?? null, p.stateKey]);
  const services = {
    config: { get: async () => config },
    state: {
      get: async (p: Record<string, unknown>) => state.get(stateKey(p)) ?? null,
      set: async (p: Record<string, unknown>) => { state.set(stateKey(p), p.value); },
      delete: async (p: Record<string, unknown>) => { state.delete(stateKey(p)); },
    },
    events: { subscribe: async () => {}, emit: async () => {}, listLifecycle: async () => [], acknowledgeLifecycle: async () => {} },
    logger: { log: async (p: Record<string, unknown>) => { logs.push(String(p.message)); } },
    // services/plugin-host-services.js issues.get: company-scoped row, or null.
    issues: { get: async (p: Record<string, unknown>) => {
      const issue = issues.get(String(p.issueId));
      return issue && issue.companyId === p.companyId ? issue : null;
    } },
    executionWorkspaces: { get: async (p: Record<string, unknown>) => {
      const row = workspaceRows.get(String(p.workspaceId));
      return row && row.companyId === p.companyId ? toPluginExecutionWorkspaceMetadata(row) : null;
    } },
    // services/plugin-secrets-handler.js resolve: parse the ref, then require exactly one binding at configPath.
    secrets: { resolve: async (p: Record<string, unknown>) => {
      const ref = envBindingSecretRefSchema.safeParse(p.secretRef);
      if (!ref.success) throw new Error("Invalid secret reference for plugin");
      const matches = bindings.filter((b) => b.secretId === ref.data.secretId && b.versionSelector === (ref.data.version ?? "latest")
        && (!p.configPath || b.configPath === p.configPath));
      if (matches.length !== 1) throw new Error(matches.length ? "Plugin secret reference is ambiguous" : "Secret is not bound to plugin");
      return "scoped-boat-key";
    } },
  };
  const unwired = new Proxy({}, { get: (_t, ns) => new Proxy({}, { get: (_u, fn) => async () => { throw new Error(`host service ${String(ns)}.${String(fn)} not wired in contract test`); } }) });
  const handlers = createHostClientHandlers({
    pluginId: "contract-plugin", capabilities: manifest.capabilities as PluginCapability[],
    services: new Proxy(services, { get: (target, ns) => (target as Record<string | symbol, unknown>)[ns] ?? (unwired as Record<string | symbol, unknown>)[ns] }) as unknown as HostServices,
  }) as unknown as Record<string, (params: unknown, context?: unknown) => Promise<unknown>>;

  const send = (message: unknown) => toWorker.write(`${JSON.stringify(message)}\n`);
  const scopeFor = (id: unknown) => (typeof id === "string" ? invocations.get(id) ?? null : null);
  async function onWorkerMessage(message: Record<string, unknown>) {
    if (message.method && message.id != null) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const scope = scopeFor(message.paperclipInvocationId);
      calls.push({ method: String(message.method), params, scope });
      const handler = handlers[String(message.method)];
      try {
        if (!handler) throw new Error(`unknown host method ${String(message.method)}`);
        const result = await handler(params, scope ? { invocationScope: { companyId: scope } } : {});
        send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
      } catch (error) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      }
    } else if (message.method === "log") {
      logs.push(String((message.params as Record<string, unknown>)?.message));
    } else if (message.id != null) {
      pending.get(Number(message.id))?.(message as never);
      pending.delete(Number(message.id));
    }
  }
  let buffer = "";
  fromWorker.on("data", (chunk) => {
    buffer += String(chunk);
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) void onWorkerMessage(JSON.parse(line));
    }
  });
  /** plugin-worker-manager.js: every call/notify with a companyId-bearing payload carries a host-minted invocation. */
  function invocation(scopeCompanyId: string | null) {
    if (!scopeCompanyId) return {};
    const id = randomUUID();
    invocations.set(id, scopeCompanyId);
    return { paperclipInvocation: { id, scope: { companyId: scopeCompanyId } } };
  }
  function call<T>(method: string, params: Record<string, unknown>, scopeCompanyId: string | null): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result as T)));
      send({ jsonrpc: "2.0", id, method, params, ...invocation(scopeCompanyId) });
    });
  }
  function notify(method: string, params: Record<string, unknown>, scopeCompanyId: string | null) {
    send({ jsonrpc: "2.0", method, params, ...invocation(scopeCompanyId) });
  }
  async function until(predicate: () => boolean, what: string) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return {
    calls, logs, issues, workspaceRows, state, call, notify, until,
    initialize: () => call<{ ok: boolean }>("initialize", {
      manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "default", hostVersion: "2026.1023.0" },
    }, null),
    stop: () => { worker.stop(); toWorker.destroy(); fromWorker.destroy(); },
  };
}

const exec = manifest.apiRoutes!.find((route) => route.routeKey === "offload_exec")!;
const execBody = () => ({ version: 1, commandId, executionWorkspaceId: workspaceId, argv: ["test", "--locked"],
  cwdRelative: ".", env: {}, queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: true });

type ExecReply = { status: number; body: { code?: string; detail?: string } };
const NOT_OWNER = "run is not known to belong to this agent";

describe("stock Paperclip 2026.1023.0 local-run offload contract", () => {
  let source: string;
  let host: ReturnType<typeof startHost>;
  const execAs = (actor: { agentId: string; companyId: string; runId: string | null }) =>
    host.call<ExecReply>("handleApiRequest", scopedRouteInput(exec, actor, execBody()), companyId);
  /** The start event is asynchronous and only records ownership: wait until the run is no longer a stranger. */
  async function untilOwned(actor: { agentId: string; companyId: string; runId: string | null }): Promise<ExecReply> {
    for (const deadline = Date.now() + 5000; ; await new Promise((resolve) => setTimeout(resolve, 10))) {
      const reply = await execAs(actor);
      if (reply.body.detail !== NOT_OWNER) return reply;
      if (Date.now() > deadline) throw new Error("timed out waiting for run ownership");
    }
  }
  /** A stock host cannot admit new work: no verified run identity, no atomic create. */
  const failsClosed = (reply: ExecReply) => {
    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe("OFFLOAD_FORBIDDEN");
    expect(reply.body.detail).not.toBe(NOT_OWNER);
  };
  const eagerBindingCalls = () => host.calls.filter((entry) => ["issues.get", "executionWorkspaces.get", "secrets.resolve"].includes(entry.method));
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    source = await mkdtemp(path.join(tmpdir(), "boat-host-contract-"));
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/example/public\n');
  });
  afterEach(async () => {
    try { await host?.call("shutdown", {}, null); } catch { /* worker already gone */ }
    host?.stop();
    vi.useRealTimers();
    await rm(source, { recursive: true, force: true });
  });

  it("(5) the shipped manifest parses and passes the host's feature -> capability validator", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);
    const declared = new Set(parsed.capabilities);
    // services/plugin-capability-validator.js FEATURE_CAPABILITIES; this manifest declares no UI slots or launchers.
    const featureCapabilities: Record<string, string> = {
      tools: "agent.tools.register", jobs: "jobs.schedule", webhooks: "webhooks.receive", database: "database.namespace.migrate",
      environmentDrivers: "environment.drivers.register", agents: "agents.managed", projects: "projects.managed",
      routines: "routines.managed", objectReferences: "external.objects.detect",
    };
    const missing = Object.entries(featureCapabilities)
      .filter(([feature]) => ((parsed as Record<string, unknown>)[feature] as unknown[] | undefined)?.length)
      .map(([, capability]) => capability).filter((capability) => !declared.has(capability as PluginCapability));
    expect(missing).toEqual([]);
    expect(parsed.ui?.slots ?? []).toEqual([]);
    // routes/plugins.js only dispatches scoped routes for plugins holding api.routes.register.
    expect(declared.has("api.routes.register")).toBe(true);
    // Offload routes are agent-authenticated, resolve the company from the agent itself, and need no issueId param.
    for (const route of parsed.apiRoutes!.filter((entry) => entry.routeKey.startsWith("offload_"))) {
      expect(route).toMatchObject({ auth: "agent" });
      expect(route.companyResolution).toBeUndefined();
      expect(route.checkoutPolicy ?? "none").toBe("none");
    }
  });

  it("(1-4) a started local run records ownership only; a stock host fails closed for new work and never binds eagerly", async () => {
    host = startHost(source);
    expect((await host.initialize()).ok).toBe(true);
    const actor = { agentId, companyId, runId };
    expect((await execAs(actor)).body.detail).toBe(NOT_OWNER);

    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    // The exact grant matches the request, yet the stock host supplies no
    // authenticated run identity, so the dry-run is denied rather than admitted.
    failsClosed(await untilOwned(actor));
    expect(host.logs).not.toContain("boat: bound local run for offload");
    // Ownership records do not establish an exact-run source or execution binding.
    expect(eagerBindingCalls()).toEqual([]);
    expect(host.calls.some((entry) => entry.method === "secrets.resolve")).toBe(false);
    expect((await execAs({ ...actor, runId: randomUUID() })).status).toBe(403);
  }, TIMEOUT);

  it("(6) with no exact grant configured, a stock host keeps the v0.2.14 path: an owned run binds and is admitted", async () => {
    const saved = config.offloadAdmission;
    (config as Record<string, unknown>).offloadAdmission = null;
    try {
      host = startHost(source);
      await host.initialize();
      const actor = { agentId, companyId, runId };
      await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
      // No authenticated run identity or atomic create is needed: the dry-run
      // binds the run's own allowlisted workspace and is answered, not denied.
      const reply = await untilOwned(actor);
      expect(reply.status).toBe(200);
      expect(host.logs).toContain("boat: bound local run for offload");
      expect((await execAs({ ...actor, runId: randomUUID() })).status).toBe(403);
      expect([...host.state.keys()].filter((key) => key.includes("boat-offload-admission"))).toEqual([]);
    } finally {
      config.offloadAdmission = saved;
    }
  }, TIMEOUT);

  it.each([
    { tool: "node", runner: "npm", argv: ["test"], profile: "node-public-1" },
    { tool: "python", runner: "pytest", argv: ["tests"], profile: "python-public-1" },
  ])("refuses unbound $tool duration reports with no SDK source lookup or write, stable or drifted", async (command) => {
    resetReportBudgets();
    host = startHost(source);
    await host.initialize();
    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    await untilOwned({ agentId, companyId, runId });
    const aliasId = host.workspaceRows.get(workspaceId)!.projectWorkspaceId;
    if (typeof aliasId !== "string") throw new Error("fixture is missing its project alias");
    const reportFor = (id: string) => host.call<ExecReply>("handleApiRequest", scopedRouteInput({ routeKey: "offload_report" },
      { companyId, runId, agentId }, { executionWorkspaceId: id, tool: command.tool, runner: command.runner,
        argv: command.argv, durationSeconds: 120 }), companyId);
    const sdkReads = () => host.calls.filter((entry) => ["issues.get", "executionWorkspaces.get", "secrets.resolve"].includes(entry.method)).length;
    const stateBefore = structuredClone([...host.state.entries()]);
    const readsBefore = sdkReads();
    const refuseAll = async () => {
      for (const id of [aliasId, workspaceId]) expect((await reportFor(id)).status).toBe(403);
      expect(sdkReads()).toBe(readsBefore);
      expect([...host.state.entries()]).toEqual(stateBefore);
    };
    await refuseAll();
    const other = path.join(source, "other");
    await mkdir(path.join(other, ".git"), { recursive: true });
    await writeFile(path.join(other, ".git", "config"), '[remote "origin"]\nurl = https://github.com/example/other\n');
    const otherId = randomUUID();
    host.workspaceRows.set(otherId, { ...host.workspaceRows.get(workspaceId)!, id: otherId,
      cwd: other, repoUrl: "https://github.com/example/other" });
    host.issues.set(issueId, { ...host.issues.get(issueId)!, executionWorkspaceId: otherId });
    await refuseAll();
    expect((await reportFor(otherId)).status).toBe(403);
    expect([...host.state.keys()].some((key) => key.includes("offload.duration"))).toBe(false);
    failsClosed(await execAs({ companyId, runId, agentId }));
  }, TIMEOUT);

  it("(1) an agent key replaying another agent's run id in X-Paperclip-Run-Id is refused", async () => {
    host = startHost(source);
    await host.initialize();
    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    failsClosed(await untilOwned({ agentId, companyId, runId }));
    // middleware/auth.js agent_key path: runId is the unsigned header, agentId is the key's own agent.
    const spoofed = { agentId: randomUUID(), companyId, runId };
    for (const routeKey of ["offload_exec", "offload_read", "offload_heartbeat", "offload_cancel", "offload_report"]) {
      const reply = await host.call<{ status: number; body: { detail?: string } }>("handleApiRequest",
        { ...scopedRouteInput({ routeKey }, spoofed, execBody()), params: { commandId: randomUUID() } }, companyId);
      expect(reply.status, routeKey).toBe(403);
      expect(reply.body.detail, routeKey).toBe("run is not known to belong to this agent");
    }
  }, TIMEOUT);

  it("(2) a run without an issue in its context snapshot reads nothing and fails closed", async () => {
    host = startHost(source);
    await host.initialize();
    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId: null }) }, companyId);
    failsClosed(await untilOwned({ agentId, companyId, runId }));
    expect(host.calls.some((entry) => entry.method === "issues.get")).toBe(false);
  }, TIMEOUT);

  it("(3) a workspace with no local cwd (provider ref only) never resolves a secret or binds at run start", async () => {
    host = startHost(source);
    await host.initialize();
    host.workspaceRows.set(workspaceId, { ...host.workspaceRows.get(workspaceId)!, cwd: null, providerRef: "remote:vm-1" });
    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    failsClosed(await untilOwned({ agentId, companyId, runId }));
    expect(host.calls.some((entry) => entry.method === "secrets.resolve")).toBe(false);
    expect(host.logs).not.toContain("boat: bound local run for offload");
  }, TIMEOUT);

  it("(4) a secret ref saved without its plugin binding is never resolved at run start", async () => {
    host = startHost(source, { bindings: [{ secretId, configPath: "someOtherField", versionSelector: "latest" }] });
    await host.initialize();
    await host.call("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    failsClosed(await untilOwned({ agentId, companyId, runId }));
    expect(host.calls.some((entry) => entry.method === "secrets.resolve")).toBe(false);
  }, TIMEOUT);

  it("(2) host reads stay inside the event's company: a cross-company start cannot read another company's source", async () => {
    host = startHost(source);
    await host.initialize();
    await host.call("onEvent", { event: runStartedEvent({ companyId: otherCompanyId, runId, agentId, issueId }) }, otherCompanyId);
    expect(eagerBindingCalls()).toEqual([]);
    expect(host.calls.some((entry) => entry.method === "secrets.resolve" || entry.method === "executionWorkspaces.get")).toBe(false);
    expect((await execAs({ agentId, companyId, runId })).body.detail).toBe(NOT_OWNER);
  }, TIMEOUT);
});
