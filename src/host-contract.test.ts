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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { envBindingSecretRefSchema, pluginManifestV1Schema } from "@paperclipai/shared";
import { createHostClientHandlers, getRequiredCapability, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import type { HostServices, PluginCapability } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import manifest from "./manifest.js";
import plugin from "./plugin.js";

const TIMEOUT = 20_000;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();
const runId = randomUUID();
const issueId = randomUUID();
const workspaceId = randomUUID();
const environmentId = randomUUID();
const secretId = randomUUID();
const config = {
  offloadLocalRunsEnabled: true,
  offloadLocalEnvironmentId: environmentId,
  offloadLocalApiKeySecretRef: { type: "secret_ref", secretId },
  offloadLocalDriverConfig: { maxOffloadVms: 1 },
};

/** services/heartbeat/run-lifecycle.js publishRunLifecyclePluginEventData, status "running". */
function runStartedEvent(run: { companyId: string; runId: string; agentId: string; issueId: string | null }) {
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
  const issues = new Map<string, Record<string, unknown>>([[issueId, { id: issueId, companyId, status: "in_progress", executionWorkspaceId: workspaceId }]]);
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
    calls, logs, issues, workspaceRows, call, notify, until,
    initialize: () => call<{ ok: boolean }>("initialize", {
      manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "default", hostVersion: "2026.1023.0" },
    }, null),
    stop: () => { worker.stop(); toWorker.destroy(); fromWorker.destroy(); },
  };
}

const exec = manifest.apiRoutes!.find((route) => route.routeKey === "offload_exec")!;
const execBody = () => ({ version: 1, commandId: randomUUID(), executionWorkspaceId: workspaceId, argv: ["test", "--locked"],
  cwdRelative: ".", env: {}, queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: true });

describe("stock Paperclip 2026.1023.0 local-run offload contract", () => {
  let source: string;
  let host: ReturnType<typeof startHost>;
  beforeEach(async () => { source = await mkdtemp(path.join(tmpdir(), "boat-host-contract-")); });
  afterEach(async () => {
    try { await host?.call("shutdown", {}, null); } catch { /* worker already gone */ }
    host?.stop();
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

  it("(1-4) binds a started local run from host data and admits that run's own auth:agent route", async () => {
    host = startHost(source);
    expect((await host.initialize()).ok).toBe(true);
    const actor = { agentId, companyId, runId };
    expect((await host.call<{ status: number }>("handleApiRequest", scopedRouteInput(exec, actor, execBody()), companyId)).status).toBe(403);

    host.notify("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    await host.until(() => host.logs.includes("boat: bound local run for offload"), "local-run binding");

    // Every worker->host call on the binding path ran inside the event's company scope and passed the SDK gate.
    const bindingCalls = host.calls.filter((entry) => ["issues.get", "executionWorkspaces.get", "secrets.resolve"].includes(entry.method));
    expect(bindingCalls.map((entry) => entry.method)).toEqual(["issues.get", "executionWorkspaces.get", "secrets.resolve"]);
    for (const entry of bindingCalls) {
      expect(entry.scope).toBe(companyId);
      expect(manifest.capabilities).toContain(getRequiredCapability(entry.method as never));
    }
    expect(bindingCalls[0]!.params).toMatchObject({ issueId, companyId });
    expect(bindingCalls[1]!.params).toMatchObject({ workspaceId, companyId });
    expect(bindingCalls[2]!.params).toMatchObject({ secretRef: config.offloadLocalApiKeySecretRef, companyId, configPath: "offloadLocalApiKeySecretRef" });

    const admitted = await host.call<{ status: number; body: unknown }>("handleApiRequest", scopedRouteInput(exec, actor, execBody()), companyId);
    expect(admitted.status).toBe(200);
    expect((await host.call<{ status: number }>("handleApiRequest", scopedRouteInput(exec, { ...actor, runId: randomUUID() }, execBody()), companyId)).status).toBe(403);
  }, TIMEOUT);

  it("(1) an agent key replaying another agent's run id in X-Paperclip-Run-Id is refused", async () => {
    host = startHost(source);
    await host.initialize();
    host.notify("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    await host.until(() => host.logs.includes("boat: bound local run for offload"), "local-run binding");
    // middleware/auth.js agent_key path: runId is the unsigned header, agentId is the key's own agent.
    const spoofed = { agentId: randomUUID(), companyId, runId };
    for (const routeKey of ["offload_exec", "offload_read", "offload_heartbeat", "offload_cancel", "offload_report"]) {
      const reply = await host.call<{ status: number; body: { detail?: string } }>("handleApiRequest",
        { ...scopedRouteInput({ routeKey }, spoofed, execBody()), params: { commandId: randomUUID() } }, companyId);
      expect(reply.status, routeKey).toBe(403);
      expect(reply.body.detail, routeKey).toBe("run is not known to belong to this agent");
    }
  }, TIMEOUT);

  it("(2) a run without an issue in its context snapshot binds nothing", async () => {
    host = startHost(source);
    await host.initialize();
    host.notify("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId: null }) }, companyId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.calls.some((entry) => entry.method === "issues.get")).toBe(false);
    expect((await host.call<{ status: number }>("handleApiRequest", scopedRouteInput(exec, { agentId, companyId, runId }, execBody()), companyId)).status).toBe(503);
  }, TIMEOUT);

  it("(3) a workspace with no local cwd (provider ref only) binds nothing", async () => {
    host = startHost(source);
    await host.initialize();
    host.workspaceRows.set(workspaceId, { ...host.workspaceRows.get(workspaceId)!, cwd: null, providerRef: "remote:vm-1" });
    host.notify("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    await host.until(() => host.calls.some((entry) => entry.method === "executionWorkspaces.get"), "workspace read");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.calls.some((entry) => entry.method === "secrets.resolve")).toBe(false);
    expect(host.logs).not.toContain("boat: bound local run for offload");
  }, TIMEOUT);

  it("(4) a secret ref saved without its plugin binding is not resolved", async () => {
    host = startHost(source, { bindings: [{ secretId, configPath: "someOtherField", versionSelector: "latest" }] });
    await host.initialize();
    host.notify("onEvent", { event: runStartedEvent({ companyId, runId, agentId, issueId }) }, companyId);
    await host.until(() => host.logs.includes("boat: local-run offload binding skipped"), "binding skip");
    expect((await host.call<{ status: number }>("handleApiRequest", scopedRouteInput(exec, { agentId, companyId, runId }, execBody()), companyId)).status).toBe(503);
  }, TIMEOUT);

  it("(2) host reads stay inside the event's company: a cross-company issue is invisible", async () => {
    host = startHost(source);
    await host.initialize();
    host.notify("onEvent", { event: runStartedEvent({ companyId: otherCompanyId, runId, agentId, issueId }) }, otherCompanyId);
    await host.until(() => host.calls.some((entry) => entry.method === "issues.get"), "issue read");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.calls.find((entry) => entry.method === "issues.get")).toMatchObject({ scope: otherCompanyId, params: { companyId: otherCompanyId } });
    expect(host.calls.some((entry) => entry.method === "executionWorkspaces.get")).toBe(false);
  }, TIMEOUT);
});
