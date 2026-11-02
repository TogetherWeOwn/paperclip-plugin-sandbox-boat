// Local-run offload binding. A run that stays on the Paperclip host gets no
// environmentRealizeWorkspace call, so offload had no source authority for it.
// This module builds the same native realization payload from the
// agent.run.started event (run -> issue), the issue's execution workspace id
// (or, when the live issue shape leaves it null, the issue's project workspace
// id), and the resolved workspace (workspace -> local path, repo).
//
// The workspace row itself is NOT authority: an agent with runtime access can
// rewrite its cwd/repoUrl, so the row only nominates a candidate source. The
// bind stands only when the operator-owned facts agree: realpath(source) lies
// inside an `offloadLocalSourceRoots` entry, and the checkout's own on-disk
// `remote.origin.url` canonicalizes to the same repo id as the row's repoUrl
// (the payload then carries the on-disk URL). Both facts are re-checked on
// every executor resolve (offload-ssh-runtime). The Boat secret is resolved
// last, after every check, so refused binds never spend secret resolutions.
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { canonicalRepoId } from "./offload/routes.js";

export interface LocalRunSettings {
  enabled: boolean;
  environmentId: string | null;
  apiKeySecretRef: unknown;
  driverConfig: Record<string, unknown>;
  /** Operator-listed absolute roots a local-run source must live under. Empty refuses every bind. */
  sourceRoots: string[];
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
  /** Real path of a local path, or null when it does not resolve. */
  canonicalPath(localPath: string): Promise<string | null>;
  /** The checkout's own remote.origin.url, read from disk, or null when unreadable/absent. */
  onDiskRepoUrl(localPath: string): Promise<string | null>;
  apiKey(secretRef: unknown, companyId: string): Promise<string | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** The operator-owned source roots from raw plugin config: absolute path strings only. */
export function localSourceRoots(raw: unknown): string[] {
  const config = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const roots = config.offloadLocalSourceRoots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((root): root is string => typeof root === "string" && path.isAbsolute(root) && !root.includes("\0"));
}

/** True when `canonical` (already realpath'd) equals a root or sits under one. Roots must be realpath'd too. */
export function withinRoots(canonical: string, canonicalRoots: string[]): boolean {
  return canonicalRoots.some((root) => canonical === root || canonical.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

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
    sourceRoots: localSourceRoots(raw),
  };
}

/** Returns the realization payload for a started local run, or null when any host fact is missing. */
export async function localRunRealization(
  event: { companyId: string; payload: unknown },
  settings: LocalRunSettings,
  host: LocalRunHost,
  options: { expectedWorkspaceId?: string } = {},
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
  // A bind retried from an offload request serves only the workspace that
  // request named; anything else returns before the secret is resolved.
  if (options.expectedWorkspaceId && workspaceId !== options.expectedWorkspaceId) return null;
  const localPath = source.localPath;
  if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")) return null;
  // The workspace row is agent-mutable: the source must sit under an
  // operator-listed root and the checkout itself must prove the repo.
  if (settings.sourceRoots.length === 0 || typeof source.repoUrl !== "string" || !source.repoUrl.trim()) return null;
  const canonical = await host.canonicalPath(localPath).catch(() => null);
  if (!canonical) return null;
  const canonicalRoots = (await Promise.all(settings.sourceRoots.map((root) => host.canonicalPath(root).catch(() => null))))
    .filter((root): root is string => root !== null);
  if (!withinRoots(canonical, canonicalRoots)) return null;
  const onDiskRepoUrl = await host.onDiskRepoUrl(canonical).catch(() => null);
  if (!onDiskRepoUrl) return null;
  const repoId = canonicalRepoId({ repoUrl: source.repoUrl, projectId: source.projectId });
  if (!repoId.startsWith("repo:") || canonicalRepoId({ repoUrl: onDiskRepoUrl, projectId: source.projectId }) !== repoId) return null;
  const apiKey = await host.apiKey(settings.apiKeySecretRef, companyId);
  if (!apiKey) return null;
  return {
    driverKey: "boat",
    companyId,
    environmentId: settings.environmentId,
    config: { ...settings.driverConfig, apiKey },
    lease: { providerLeaseId: null },
    workspace: {
      localPath: canonical,
      metadata: {
        workspaceRealizationRequest: {
          version: 1, companyId, environmentId: settings.environmentId,
          heartbeatRunId: payload.runId, executionWorkspaceId: workspaceId, localRun: true,
          source: { localPath: canonical, repoUrl: onDiskRepoUrl, projectId: source.projectId, projectWorkspaceId: source.projectWorkspaceId },
        },
      },
    },
  } as PluginEnvironmentRealizeWorkspaceParams;
}

/** Real host seam: symlink-free path of an existing local path, or null. */
export async function fsCanonicalPath(localPath: string): Promise<string | null> {
  return await realpath(localPath).catch(() => null);
}

const MAX_GIT_CONFIG_BYTES = 64 * 1024;

/** Bounded no-follow read of a small text file; null on any failure (symlink, fifo, oversize, unreadable). */
async function readSmallNoFollow(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_GIT_CONFIG_BYTES) return null;
    const buf = Buffer.alloc(MAX_GIT_CONFIG_BYTES + 1);
    let off = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, off, buf.length - off);
      if (bytesRead === 0) break;
      off += bytesRead;
      if (off > MAX_GIT_CONFIG_BYTES) return null;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** First `url` under `[remote "origin"]` in a git config body. Includes are never followed. */
function originUrlFromGitConfig(text: string): string | null {
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.*)$/i.exec(line);
    if (!kv) continue;
    let value = kv[1]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    return value || null;
  }
  return null;
}

/**
 * Real host seam: the checkout's `remote.origin.url`, parsed from its git
 * config on disk (never by running git, never following includes). Handles a
 * `.git` directory and a linked-worktree `.git` file (via `commondir`).
 * `canonicalSource` must already be realpath'd; a symlinked `.git` refuses.
 */
export async function readGitOriginUrl(canonicalSource: string): Promise<string | null> {
  const dotGit = path.join(canonicalSource, ".git");
  // A symlinked .git could redirect the config read outside the checkout.
  if ((await lstat(dotGit).catch(() => null))?.isSymbolicLink() !== false) return null;
  const asDirectory = await readSmallNoFollow(path.join(dotGit, "config"));
  if (asDirectory !== null) return originUrlFromGitConfig(asDirectory);
  const gitFile = await readSmallNoFollow(dotGit);
  const gitDirRel = gitFile && /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1]?.trim();
  if (!gitDirRel) return null;
  const gitDir = await realpath(path.resolve(canonicalSource, gitDirRel)).catch(() => null);
  if (!gitDir) return null;
  const commonRel = (await readSmallNoFollow(path.join(gitDir, "commondir")))?.trim();
  const configDir = commonRel ? await realpath(path.resolve(gitDir, commonRel)).catch(() => null) : gitDir;
  if (!configDir) return null;
  const config = await readSmallNoFollow(path.join(configDir, "config"));
  return config === null ? null : originUrlFromGitConfig(config);
}
