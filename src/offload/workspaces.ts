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

/** Every workspace a run was ever bound to, so a terminal event or release can forget them all without in-memory state. */
function runIndexScope(companyId: string, runId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload-run-workspaces", stateKey: runId };
}

export class NativeOffloadWorkspaces {
  private readonly indexWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly state: StateClientLike) {}

  /** Serialize read-modify-write of one run's index in this worker. */
  private withIndex<T>(companyId: string, runId: string, fn: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([companyId, runId]);
    const next = (this.indexWrites.get(key) ?? Promise.resolve()).then(fn);
    const settled = next.catch(() => undefined);
    this.indexWrites.set(key, settled);
    void settled.then(() => {
      if (this.indexWrites.get(key) === settled) this.indexWrites.delete(key);
    });
    return next;
  }

  private async indexed(companyId: string, runId: string): Promise<string[]> {
    const saved = record(await this.state.get(runIndexScope(companyId, runId)));
    return Array.isArray(saved.workspaces) ? saved.workspaces.filter((id): id is string => typeof id === "string") : [];
  }

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
    // Index first: a binding must never exist that forgetRun cannot find.
    await this.withIndex(params.companyId, runId, async () => {
      const workspaces = await this.indexed(params.companyId, runId);
      if (!workspaces.includes(workspaceId)) {
        await this.state.set(runIndexScope(params.companyId, runId), { version: 1, workspaces: [...workspaces, workspaceId] });
      }
    });
    await this.state.set(scope(params.companyId, workspaceId, runId), {
      version: 1, companyId: params.companyId, runId, workspaceId, workspace,
    });
  }

  async forget(companyId: string, workspaceId: string, runId: string): Promise<void> {
    await this.state.delete(scope(companyId, workspaceId, runId));
  }

  /** Forget every workspace binding of a run, from the persisted index. */
  async forgetRun(companyId: string, runId: string): Promise<void> {
    await this.withIndex(companyId, runId, async () => {
      for (const workspaceId of await this.indexed(companyId, runId)) await this.forget(companyId, workspaceId, runId);
      await this.state.delete(runIndexScope(companyId, runId));
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
