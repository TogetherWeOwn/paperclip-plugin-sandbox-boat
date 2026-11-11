import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { parseDriverConfig, validateDriverConfig } from "./config.js";
import { BoatProviderError } from "./errors.js";
import { SWEEP_JOB_KEY } from "./manifest.js";
import { offloadError } from "./offload/errors.js";
import type { RouteActor } from "./offload/routes.js";
import { fsCanonicalPath, localRunRealization, localRunSettings, readGitOriginUrl, type LocalRunHost } from "./local-run-binding.js";
import { runOutsideInvocation } from "./proactive.js";
import { BoatVmManager } from "./vm-manager.js";
import type { ManagerDeps } from "./vm-manager.js";

let manager: BoatVmManager | null = null;
let managerOverrides: Partial<ManagerDeps> = {};

/** Test hook: inject a fake clock, sleep or SSH manager before setup(). */
export function setManagerOverridesForTests(overrides: Partial<ManagerDeps>): void {
  managerOverrides = overrides;
  manager = null;
}

export function currentManager(): BoatVmManager {
  if (!manager) throw new Error("boat sandbox provider is not set up yet.");
  return manager;
}

function requireManager(): BoatVmManager {
  return currentManager();
}

function toRouteActor(actor: PluginApiRequestInput["actor"]): RouteActor {
  // Additive host/SDK field. Absent on older hosts; never reconstruct it from
  // headers, body, environment, generic runId or the ownership lookup.
  const trusted = actor as PluginApiRequestInput["actor"] & { readonly authenticatedRunId?: string | null };
  return { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId ?? null,
    runId: actor.runId ?? null, authenticatedRunId: trusted.authenticatedRunId ?? null };
}

let bindLocalRun: ((companyId: string, runId: string, issueId: string, expectedWorkspaceId?: string) => Promise<boolean>) | null = null;
/** In-flight request-triggered binds per company+run, so parallel requests share one attempt (and one secret resolution). */
const pendingBinds = new Map<string, Promise<boolean>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Retry the local-run bind once the run asks to offload: by then Paperclip has prepared its workspace. */
async function bindOnFirstRequest(boat: BoatVmManager, input: PluginApiRequestInput): Promise<void> {
  const runId = input.actor.actorType === "agent" ? input.actor.runId : null;
  const workspaceId = (input.body as { executionWorkspaceId?: unknown } | null)?.executionWorkspaceId;
  if (!runId || typeof workspaceId !== "string" || !UUID.test(workspaceId) || !bindLocalRun) return;
  const issueId = boat.localRunIssue(input.companyId, runId);
  // Skip only when this run is already bound under the requested id: a run
  // bound under a different host-owned id of the same workspace (execution vs
  // project workspace id) can still complete a validated bind for the id it
  // reports. A bogus id never reaches a secret resolution: bindLocalRun's
  // expected-workspace check refuses it first.
  if (!issueId || boat.hasOffloadBinding(input.companyId, runId, workspaceId)) return;
  const pendingKey = JSON.stringify([input.companyId, runId]);
  let pending = pendingBinds.get(pendingKey);
  if (!pending) {
    pending = bindLocalRun(input.companyId, runId, issueId, workspaceId)
      .finally(() => { pendingBinds.delete(pendingKey); });
    pendingBinds.set(pendingKey, pending);
  }
  await pending;
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    manager = new BoatVmManager({
      state: ctx.state,
      logger: ctx.logger,
      issues: {
        get: async (issueId, companyId) => {
          const issue = await ctx.issues.get(issueId, companyId);
          return issue ? {
            status: issue.status,
            executionRunId: issue.executionRunId ?? null,
            checkoutRunId: issue.checkoutRunId ?? null,
            ...(Object.prototype.hasOwnProperty.call(issue, "executionWorkspaceSettings")
              ? { executionWorkspaceSettings: issue.executionWorkspaceSettings } : {}),
          } : null;
        },
      },
      offloadConfig: async (companyId) => ctx.config.get(companyId),
      ...managerOverrides,
    });
    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      // The job's own invocation has no company, so run the sweep outside it (proactive.ts).
      const report = await runOutsideInvocation(() => requireManager().sweep("schedule"));
      // Telemetry follows cleanup, never adds a scheduler or delays a due stop.
      await runOutsideInvocation(() => requireManager().sampleCapacity());
      if (report.stopped.length || report.deleted.length || report.errors.length) {
        ctx.logger.info("boat: idle sweep finished", { ...report });
      }
    });
    const workspaceHost: Omit<LocalRunHost, "apiKey"> = {
      issueWorkspaceId: async (id, company) => (await ctx.issues.get(id, company))?.executionWorkspaceId ?? null,
      // The task's current network policy gates the local-run bind, mirroring
      // the resume-lease reader: field presence is part of the contract.
      issueExecutionWorkspaceSettings: async (id, company) => {
        const issue = await ctx.issues.get(id, company);
        if (!issue) return { present: false, settings: undefined };
        return { present: Object.prototype.hasOwnProperty.call(issue, "executionWorkspaceSettings"),
          settings: issue.executionWorkspaceSettings };
      },
      // The live issue shape leaves executionWorkspaceId null; the shim then
      // reports the project workspace id, so resolve that host-owned workspace.
      issueProjectWorkspace: async (id, company) => {
        const workspace = await ctx.projects.getWorkspaceForIssue(id, company);
        return workspace ? {
          id: typeof workspace.id === "string" ? workspace.id : "",
          projectId: typeof workspace.projectId === "string" ? workspace.projectId : "",
          path: typeof workspace.path === "string" ? workspace.path : null,
          repoUrl: typeof workspace.repoUrl === "string" ? workspace.repoUrl : null,
        } : null;
      },
      workspace: async (workspaceId, company) => await ctx.executionWorkspaces.get(workspaceId, company),
      canonicalPath: fsCanonicalPath,
      onDiskRepoUrl: readGitOriginUrl,
    };
    // Local runs bind only after admission on an offload request: any request on
    // the broad (null-policy) path, only the real submit of an exact grant. Start
    // events record ownership, never infer telemetry sources or resolve credentials.
    bindLocalRun = async (companyId: string, runId: string, issueId: string, expectedWorkspaceId?: string) => {
      const settings = localRunSettings(await ctx.config.get(companyId).catch(() => ({})));
      if (!settings.enabled) return false;
      const params = await localRunRealization({ companyId, payload: { runId, issueId } }, settings, {
        ...workspaceHost,
        apiKey: async (secretRef, company) => await ctx.secrets.resolve(secretRef as never, { companyId: company, configPath: "offloadLocalApiKeySecretRef" }),
      }, { expectedWorkspaceId,
        onRefuse: (reason) => ctx.logger.warn("boat: local-run offload binding refused", { runId, issueId, reason }),
      }).catch((error: unknown) => {
        ctx.logger.warn("boat: local-run offload binding skipped", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      // A failed state write leaves the run unbound and retryable; the route answers 503 (local fallback), never a 500.
      const bound = params ? await requireManager().rememberLocalRun(params).catch((error: unknown) => {
        ctx.logger.warn("boat: local-run offload binding not persisted", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }) : false;
      if (bound && params) {
        const request = params.workspace.metadata?.workspaceRealizationRequest as Record<string, unknown> | undefined;
        const workspaceId = typeof request?.executionWorkspaceId === "string" ? request.executionWorkspaceId : null;
        // The shim submits under the project workspace id even for execution
        // workspaces, and later executor logs carry that id; log the alias
        // here too so the bind and refusal lines correlate.
        const source = request?.source as Record<string, unknown> | undefined;
        const projectWorkspaceId = typeof source?.projectWorkspaceId === "string" ? source.projectWorkspaceId : null;
        ctx.logger.info("boat: bound local run for offload", { runId, workspaceId,
          ...(projectWorkspaceId !== null && projectWorkspaceId !== workspaceId ? { projectWorkspaceId } : {}) });
      }
      return bound;
    };
    ctx.events.on("agent.run.started", async (event) => {
      const payload = (event.payload ?? {}) as { runId?: unknown; issueId?: unknown; agentId?: unknown };
      if (typeof payload.runId !== "string") return;
      // Record every started run in memory: its owner gates every offload
      // route, and a transient config failure here stays recoverable on the
      // run's first offload request. The persisted owner row is written only
      // when the company uses Boat at all (local-run offload or a seen
      // whole-run config), so idle companies add no per-run state rows.
      // Workspace binding still requires an admitted offload request.
      const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
      const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
      // Install the in-memory owner before fetching settings: requests can
      // race this event, but still pass the admission gate.
      if (!(await requireManager().startLocalRun(event.companyId, payload.runId, issueId, agentId, false))) return;
      let companyConfig: unknown;
      try {
        companyConfig = await ctx.config.get(event.companyId);
      } catch {
        // Settings are unverified: record the owner as before so the first
        // offload request can recover the bind, but do not bind yet.
        await requireManager().startLocalRun(event.companyId, payload.runId, issueId, agentId, true);
        return;
      }
      const persist = localRunSettings(companyConfig).enabled || requireManager().hasWholeRunConfig(event.companyId);
      await requireManager().startLocalRun(event.companyId, payload.runId, issueId, agentId, persist);
      // Start events never bind workspaces or resolve credentials. Only an
      // admitted offload request may do that through bindOnFirstRequest.
    });
    for (const done of ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
      ctx.events.on(done, async (event) => {
        const runId = (event.payload as { runId?: unknown } | null)?.runId;
        if (typeof runId === "string") {
          await manager?.forgetLocalRun(event.companyId, runId);
        }
      });
    }
    ctx.logger.info("boat sandbox provider plugin ready");
  },

  async onHealth() {
    return {
      status: "ok",
      message: "boat sandbox provider plugin healthy",
      details: manager ? manager.health() : {},
    };
  },

  async onShutdown() {
    await manager?.shutdown();
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const boat = requireManager();
    if (input.routeKey === "usage") {
      const refreshRaw = input.query.refresh;
      const refresh = (Array.isArray(refreshRaw) ? refreshRaw[0] : refreshRaw) !== "0";
      return { status: 200, body: await boat.usageSummary(input.companyId, { refresh }) };
    }
    if (input.routeKey === "sweep") {
      // Acts on and reports only the caller's company; the scheduled job sweeps every company.
      return { status: 200, body: await boat.sweep("api", { force: true, companyId: input.companyId }) };
    }
    if (input.routeKey.startsWith("offload_") && input.actor.actorType === "agent" && input.actor.runId
      && !(await boat.localRunOwnedBy(input.companyId, input.actor.runId, input.actor.agentId))) {
      return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "run is not known to belong to this agent", { commandId: null }) };
    }
    if (input.routeKey === "offload_exec") {
      const response = await boat.offloadExec(input.companyId, toRouteActor(input.actor), input.body,
        () => bindOnFirstRequest(boat, input));
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_read") {
      const response = await boat.offloadRead(input.companyId, toRouteActor(input.actor), input.params, input.query);
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_verify") {
      const response = await boat.offloadVerify(input.companyId, toRouteActor(input.actor), input.params, input.body);
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_heartbeat") {
      const response = await boat.offloadHeartbeat(input.companyId, toRouteActor(input.actor), input.params);
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_cancel") {
      const response = await boat.offloadCancel(input.companyId, toRouteActor(input.actor), input.params, input.body);
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_report") {
      // The pinned SDK has no source identity recorded atomically with a run
      // start. Even a fresh event can be queued after an issue moves. Only the
      // existing exact-run registry can prove a report source; no issue fallback.
      const response = await boat.offloadReport(input.companyId, toRouteActor(input.actor), input.body);
      return { status: response.status, body: response.body };
    }
    return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
  },

  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
    let config;
    try {
      config = parseDriverConfig(params.config);
    } catch (error) {
      if (!(error instanceof BoatProviderError && error.code === "BOAT_SIZE_POLICY_INVALID")) throw error;
      return { ok: false, errors: [error.message] };
    }
    const { errors, warnings } = validateDriverConfig(config, params.config);
    if (errors.length > 0) return { ok: false, errors, warnings };
    const normalizedConfig: Record<string, unknown> = { ...config };
    // Never echo secrets back as normalized config values.
    if (normalizedConfig.apiKey == null) delete normalizedConfig.apiKey;
    if (normalizedConfig.costApiKey == null) delete normalizedConfig.costApiKey;
    // Unset means the built-in allowlist; keep it unset so it follows the plugin.
    if (normalizedConfig.envAllowlist == null) delete normalizedConfig.envAllowlist;
    if (normalizedConfig.modelProxyKeyFingerprint == null) delete normalizedConfig.modelProxyKeyFingerprint;
    return { ok: true, warnings, normalizedConfig };
  },

  async onEnvironmentProbe(params) {
    return await requireManager().probe(params);
  },

  async onEnvironmentAcquireLease(params) {
    const lease = await requireManager().acquire(params);
    requireManager().sweepSoon("acquire");
    return lease;
  },

  async onEnvironmentResumeLease(params) {
    return await requireManager().resumeLease(params);
  },

  async onEnvironmentReleaseLease(params) {
    // The sweep runs even when the release throws (a failed delete still
    // stopped the VM; the sweep retries the delete from the record).
    try {
      return await requireManager().release(params, "release");
    } finally {
      requireManager().sweepSoon("release");
    }
  },

  async onEnvironmentStopLease(params) {
    // No sweep here: release-review interleavings call the manager directly
    // to keep fire-and-forget sweeps out. A failed stop stays tracked
    // (stopping, no tombstone) for the scheduled sweep to retry.
    const receipt = await requireManager().release(params, "stop");
    if (!receipt) throw new Error("boat stop was not confirmed.");
    return receipt;
  },

  async onEnvironmentDestroyLease(params) {
    // No sweep here, matching StopLease above. A failed delete stops the VM
    // and keeps it tracked (stopped, no tombstone) for the scheduled sweep.
    return await requireManager().destroy(params);
  },

  async onEnvironmentRealizeWorkspace(params) {
    return await requireManager().realizeWorkspace(params);
  },

  async onEnvironmentSyncIn(params) {
    return await requireManager().sync(params, "in");
  },

  async onEnvironmentSyncOut(params) {
    return await requireManager().sync(params, "out");
  },

  async onEnvironmentExecute(params) {
    return await requireManager().execute(params);
  },

  async onEnvironmentCaptureTemplate(params) {
    return await requireManager().captureTemplate(params);
  },

  async onEnvironmentDeleteTemplate(params) {
    return await requireManager().deleteTemplate(params);
  },
});

export default plugin;
