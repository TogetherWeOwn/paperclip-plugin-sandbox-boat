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
    // The realization keys on the execution workspace id, but the shim reports
    // PAPERCLIP_WORKSPACE_ID, which carries the project workspace id even for
    // execution workspaces. Both ids are host-owned fields of this same
    // payload, so register the binding under the project workspace id too.
    const aliasId = workspace.projectWorkspaceId;
    const ids = aliasId && aliasId !== workspaceId ? [workspaceId, aliasId] : [workspaceId];
    const localRun = request.localRun === true;
    // Index first, and write the binding under the same lock: a binding must
    // never exist that forgetRun cannot find, even when forgetRun runs meanwhile.
    await this.withIndex(params.companyId, runId, async () => {
      const workspaces = await this.indexed(params.companyId, runId);
      const missing = ids.filter((id) => !workspaces.includes(id));
      if (missing.length > 0) {
        await this.state.set(runIndexScope(params.companyId, runId), { version: 1, workspaces: [...workspaces, ...missing] });
      }
      for (const id of ids) {
        const existing = record(await this.state.get(scope(params.companyId, id, runId)));
        // A withdrawn alias stays withdrawn for the run; a workspace may
        // still reclaim its own primary id.
        if (existing.ambiguous === true && id !== workspaceId) continue;
        const existingPath = text(record(existing.workspace).path);
        if (existingPath) {
          // A local-run binding never replaces a whole-run one; the reverse wins.
          if (existing.localRun !== true && localRun) continue;
          if (existingPath !== localPath && !(existing.localRun === true && !localRun)
            && id !== workspaceId && text(existing.executionWorkspaceId) !== workspaceId) {
            // Two execution workspaces of this run claim the shared project
            // id with different checkouts, and the shim can only send that
            // id: withdraw the alias (503, local fallback) instead of
            // silently serving the later checkout.
            await this.state.set(scope(params.companyId, id, runId), {
              version: 1, companyId: params.companyId, runId, workspaceId: id, ambiguous: true,
            });
            continue;
          }
        }
        await this.state.set(scope(params.companyId, id, runId), {
          version: 1, companyId: params.companyId, runId, workspaceId: id,
          executionWorkspaceId: workspaceId, localRun, workspace,
        });
      }
      if (!localRun) {
        // A local-run bind may have registered this same execution workspace
        // under a project alias this whole-run payload omits (the alias there
        // came from host workspace metadata for the same workspace).
        // Whole-run precedence covers that alias too: claim it for the
        // whole-run source instead of leaving the local checkout served
        // under it. Aliases of another execution workspace (and withdrawn
        // ambiguous ones) are left alone.
        for (const id of workspaces) {
          if (ids.includes(id)) continue;
          const existing = record(await this.state.get(scope(params.companyId, id, runId)));
          if (existing.ambiguous === true || text(existing.executionWorkspaceId) !== workspaceId) continue;
          await this.state.set(scope(params.companyId, id, runId), {
            version: 1, companyId: params.companyId, runId, workspaceId: id,
            executionWorkspaceId: workspaceId, localRun, workspace,
          });
        }
      }
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
    if (saved.version !== 1 || saved.companyId !== companyId || saved.runId !== runId || saved.workspaceId !== workspaceId
      || saved.ambiguous === true) return null;
    const workspace = record(saved.workspace);
    const root = text(workspace.path);
    if (!root || !isAbsolute(root) || root.includes("\0") || workspace.cwd !== root || !text(workspace.projectId)) return null;
    return { path: root, cwd: root, projectId: workspace.projectId as string,
      projectWorkspaceId: text(workspace.projectWorkspaceId), repoUrl: text(workspace.repoUrl) };
  }
}
