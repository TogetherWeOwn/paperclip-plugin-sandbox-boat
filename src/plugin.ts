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
import type { RouteActor } from "./offload/routes.js";
import { localRunRealization, localRunSettings } from "./local-run-binding.js";
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
  return { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId ?? null };
}

let bindLocalRun: ((companyId: string, runId: string, issueId: string) => Promise<boolean>) | null = null;

/** Retry the local-run bind once the run asks to offload: by then Paperclip has prepared its workspace. */
async function bindOnFirstRequest(boat: BoatVmManager, input: PluginApiRequestInput): Promise<void> {
  const runId = input.actor.actorType === "agent" ? input.actor.runId : null;
  const workspaceId = (input.body as { executionWorkspaceId?: unknown } | null)?.executionWorkspaceId;
  if (!runId || typeof workspaceId !== "string" || !bindLocalRun) return;
  const issueId = boat.localRunIssue(input.companyId, runId);
  if (!issueId || boat.hasOffloadBinding(input.companyId, runId, workspaceId)) return;
  await bindLocalRun(input.companyId, runId, issueId);
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    manager = new BoatVmManager({
      state: ctx.state,
      logger: ctx.logger,
      issues: {
        get: async (issueId, companyId) => {
          const issue = await ctx.issues.get(issueId, companyId);
          return issue ? { status: issue.status } : null;
        },
      },
      offloadConfig: async (companyId) => ctx.config.get(companyId),
      ...managerOverrides,
    });
    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      // The job's own invocation has no company, so run the sweep outside it (proactive.ts).
      const report = await runOutsideInvocation(() => requireManager().sweep("schedule"));
      if (report.stopped.length || report.deleted.length || report.errors.length) {
        ctx.logger.info("boat: idle sweep finished", { ...report });
      }
    });
    // Local runs: bind heavy-command offload from host-owned run, issue and workspace data.
    // The started event usually precedes workspace preparation, so the bind is retried
    // when the run's first offload request arrives (onApiRequest below).
    bindLocalRun = async (companyId: string, runId: string, issueId: string) => {
      const settings = localRunSettings(await ctx.config.get(companyId).catch(() => ({})));
      if (!settings.enabled) return false;
      const params = await localRunRealization({ companyId, payload: { runId, issueId } }, settings, {
        issueWorkspaceId: async (id, company) => (await ctx.issues.get(id, company))?.executionWorkspaceId ?? null,
        workspace: async (workspaceId, company) => await ctx.executionWorkspaces.get(workspaceId, company),
        apiKey: async (secretRef, company) => await ctx.secrets.resolve(secretRef as never, { companyId: company, configPath: "offloadLocalApiKeySecretRef" }),
      }).catch((error: unknown) => {
        ctx.logger.warn("boat: local-run offload binding skipped", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      // A failed state write leaves the run unbound and retryable; the route answers 403, never a 500.
      const bound = params ? await requireManager().rememberLocalRun(params).catch((error: unknown) => {
        ctx.logger.warn("boat: local-run offload binding not persisted", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }) : false;
      if (bound) ctx.logger.info("boat: bound local run for offload", { runId });
      return bound;
    };
    ctx.events.on("agent.run.started", async (event) => {
      const payload = (event.payload ?? {}) as { runId?: unknown; issueId?: unknown };
      if (typeof payload.runId !== "string" || typeof payload.issueId !== "string") return;
      // Record every started run before reading settings: the record grants nothing, and a
      // transient config failure here stays recoverable on the run's first offload request.
      if (!requireManager().startLocalRun(event.companyId, payload.runId, payload.issueId)) return;
      await bindLocalRun!(event.companyId, payload.runId, payload.issueId);
    });
    for (const done of ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
      ctx.events.on(done, async (event) => {
        const runId = (event.payload as { runId?: unknown } | null)?.runId;
        if (typeof runId === "string") await manager?.forgetLocalRun(event.companyId, runId);
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
      return { status: 200, body: await boat.sweep("api", { force: true }) };
    }
    if (input.routeKey === "offload_exec") {
      await bindOnFirstRequest(boat, input);
      const response = await boat.offloadExec(input.companyId, toRouteActor(input.actor), input.body);
      return { status: response.status, body: response.body };
    }
    if (input.routeKey === "offload_read") {
      const response = await boat.offloadRead(input.companyId, toRouteActor(input.actor), input.params, input.query);
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
    const receipt = await requireManager().release(params, "release");
    requireManager().sweepSoon("release");
    return receipt;
  },

  async onEnvironmentStopLease(params) {
    const receipt = await requireManager().release(params, "stop");
    if (!receipt) throw new Error("boat stop was not confirmed.");
    return receipt;
  },

  async onEnvironmentDestroyLease(params) {
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
