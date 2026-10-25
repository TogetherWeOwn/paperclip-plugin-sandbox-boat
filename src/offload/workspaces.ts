// Native environment-driver payloads already carry the host's realized source
// and immutable run identity. Remember only that binding, never caller roots or
// runtime-overlay commands/secrets. No execution.workspaces.read RPC is needed.
import { isAbsolute } from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import type { StateClientLike } from "../state.js";
import type { OffloadWorkspaceMeta } from "./routes.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function scope(companyId: string, workspaceId: string, runId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload-workspaces", stateKey: JSON.stringify([runId, workspaceId]) };
}

export class NativeOffloadWorkspaces {
  constructor(private readonly state: StateClientLike) {}

  /** Trusted host integration only, using the SDK realization payload. Never
   * expose this as an agent API. Source fields follow WorkspaceRealizationRequest
   * in packages/shared/src/types/workspace-runtime.ts; the host builds it in
   * server/src/services/workspace-realization.ts and forwards it unchanged. */
  async remember(params: PluginEnvironmentRealizeWorkspaceParams): Promise<void> {
    const request = record(params.workspace.metadata?.workspaceRealizationRequest);
    const source = record(request.source);
    const runId = text(request.heartbeatRunId);
    const workspaceId = text(request.executionWorkspaceId);
    const localPath = text(source.localPath);
    if (request.version !== 1 || request.companyId !== params.companyId || request.environmentId !== params.environmentId
      || !runId || !workspaceId || !localPath || !isAbsolute(localPath) || localPath.includes("\0")
      || localPath !== params.workspace.localPath) return;
    const workspace: OffloadWorkspaceMeta = {
      repoUrl: text(source.repoUrl),
      // Without a project, isolate the cache by execution workspace rather than
      // grouping unrelated task-session/agent-home sources together.
      projectId: text(source.projectId) ?? workspaceId,
      projectWorkspaceId: text(source.projectWorkspaceId),
      path: localPath,
      cwd: localPath,
    };
    await this.state.set(scope(params.companyId, workspaceId, runId), {
      version: 1, companyId: params.companyId, runId, workspaceId, workspace,
    });
  }

  async get(workspaceId: string, companyId: string, runId: string): Promise<OffloadWorkspaceMeta | null> {
    const saved = record(await this.state.get(scope(companyId, workspaceId, runId)));
    if (saved.version !== 1 || saved.companyId !== companyId || saved.runId !== runId || saved.workspaceId !== workspaceId) return null;
    const workspace = record(saved.workspace);
    const root = text(workspace.path);
    if (!root || !isAbsolute(root) || root.includes("\0") || workspace.cwd !== root || !text(workspace.projectId)) return null;
    return { path: root, cwd: root, projectId: workspace.projectId as string,
      projectWorkspaceId: text(workspace.projectWorkspaceId), repoUrl: text(workspace.repoUrl) };
  }
}
