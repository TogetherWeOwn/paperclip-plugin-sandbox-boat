// Local-run offload binding. A run that stays on the Paperclip host gets no
// environmentRealizeWorkspace call, so offload had no source authority for it.
// This module builds the same native realization payload from host-owned data
// only: the agent.run.started event (run -> issue), the issue's execution
// workspace id (or, when the live issue shape leaves it null, the issue's
// project workspace id), and the resolved workspace (workspace -> local path,
// repo). Nothing comes from the agent or the offload request body.
import path from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";

export interface LocalRunSettings {
  enabled: boolean;
  environmentId: string | null;
  apiKeySecretRef: unknown;
  driverConfig: Record<string, unknown>;
}

/** The issue's project workspace: the id the shim reports when the run has no execution workspace. */
export interface LocalRunProjectWorkspace {
  id: string;
  projectId: string;
  path: string | null;
  repoUrl: string | null;
}

export interface LocalRunHost {
  issueWorkspaceId(issueId: string, companyId: string): Promise<string | null>;
  issueProjectWorkspace(issueId: string, companyId: string): Promise<LocalRunProjectWorkspace | null>;
  workspace(workspaceId: string, companyId: string): Promise<{
    projectId: string; projectWorkspaceId: string | null; path: string | null; repoUrl: string | null;
  } | null>;
  apiKey(secretRef: unknown, companyId: string): Promise<string | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function localRunSettings(raw: unknown): LocalRunSettings {
  const config = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const driver = config.offloadLocalDriverConfig;
  const { apiKey: _ignored, ...driverConfig } = driver && typeof driver === "object" && !Array.isArray(driver)
    ? driver as Record<string, unknown> : {};
  return {
    enabled: config.offloadLocalRunsEnabled === true,
    environmentId: id(config.offloadLocalEnvironmentId) ? config.offloadLocalEnvironmentId : null,
    apiKeySecretRef: config.offloadLocalApiKeySecretRef ?? null,
    driverConfig,
  };
}

/** Returns the realization payload for a started local run, or null when any host fact is missing. */
export async function localRunRealization(
  event: { companyId: string; payload: unknown },
  settings: LocalRunSettings,
  host: LocalRunHost,
): Promise<PluginEnvironmentRealizeWorkspaceParams | null> {
  if (!settings.enabled || !settings.environmentId || !settings.apiKeySecretRef) return null;
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const { companyId } = event;
  if (!id(companyId) || !id(payload.runId) || !id(payload.issueId)) return null;
  // Isolated workspaces bind the issue's execution workspace exactly as before.
  // Otherwise the live issue shape has no execution workspace id, and the shim
  // reports PAPERCLIP_WORKSPACE_ID, the project workspace id: bind that.
  let workspaceId: string | null = null;
  let source: { localPath: string | null; repoUrl: string | null; projectId: string; projectWorkspaceId: string | null } | null = null;
  const executionWorkspaceId = await host.issueWorkspaceId(payload.issueId, companyId);
  if (id(executionWorkspaceId)) {
    const workspace = await host.workspace(executionWorkspaceId, companyId);
    if (workspace) {
      workspaceId = executionWorkspaceId;
      source = { localPath: workspace.path, repoUrl: workspace.repoUrl,
        projectId: workspace.projectId, projectWorkspaceId: workspace.projectWorkspaceId };
    }
  } else {
    const projectWorkspace = await host.issueProjectWorkspace(payload.issueId, companyId).catch(() => null);
    if (projectWorkspace && id(projectWorkspace.id)) {
      workspaceId = projectWorkspace.id;
      source = { localPath: projectWorkspace.path, repoUrl: projectWorkspace.repoUrl,
        projectId: projectWorkspace.projectId, projectWorkspaceId: projectWorkspace.id };
    }
  }
  if (!workspaceId || !source) return null;
  const localPath = source.localPath;
  if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")) return null;
  const apiKey = await host.apiKey(settings.apiKeySecretRef, companyId);
  if (!apiKey) return null;
  return {
    driverKey: "boat",
    companyId,
    environmentId: settings.environmentId,
    config: { ...settings.driverConfig, apiKey },
    lease: { providerLeaseId: null },
    workspace: {
      localPath,
      metadata: {
        workspaceRealizationRequest: {
          version: 1, companyId, environmentId: settings.environmentId,
          heartbeatRunId: payload.runId, executionWorkspaceId: workspaceId,
          source: { localPath, repoUrl: source.repoUrl, projectId: source.projectId, projectWorkspaceId: source.projectWorkspaceId },
        },
      },
    },
  } as PluginEnvironmentRealizeWorkspaceParams;
}
