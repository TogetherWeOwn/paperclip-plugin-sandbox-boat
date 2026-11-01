// Stock-worker integration. Authorization originates in native realization
// params, never an API body or execution.workspaces.read. Credentials remain in
// memory only; persisted executor state is credential-free and company scoped.
import { createHash } from "node:crypto";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { boatApi, waitReady, type BoatApiLike } from "./boat-client.js";
import { parseDriverConfig, resolveApiKey, type BoatDriverConfig } from "./config.js";
import { OffloadExecutor, type OffloadCommand, type OffloadLogger } from "./offload.js";
import { OffloadJournal, type OffloadStore } from "./offload-journal.js";
import { nestedLockfile, planDependencies } from "./offload/deps-install.js";
import { durationKey, normalizeSignature, recordDuration } from "./offload/duration-history.js";
import { canonicalRepoId, classifyCargoWorkspace, defaultRunnerFor, normalizeOffloadSettings, NODE_PROFILE, PYTHON_PROFILE, V1_PROFILE, type ServerProfile } from "./offload/routes.js";
import { cargoToolchain, classifyNode, classifyPython, isCargoOffline } from "./offload/router.js";
import { LONE_SURROGATE } from "./offload/validate.js";
import type { BackendCommand } from "./offload/broker.js";
import type { StateClientLike } from "./state.js";
import { endpointFromSshKeyResponse, type SshManager, type SshSession } from "./ssh.js";
import { SshOffloadGuest, type SshOffloadGuestDeps } from "./offload-ssh.js";
import { ARTIFACT_RETENTION_MS, SshOffloadSync, sweepArtifactRoot } from "./offload-ssh-sync.js";
import { hasSecretInFiles, listTrackedFiles, type TrackedFilesFn } from "./offload-secret-scan.js";
import { DEFAULT_SYNC_EXCLUDES, isDefaultSyncExcluded, snapshotHasDirectory } from "./offload-sync.js";

type Binding = { companyId: string; runId: string; workspaceId: string; repoId: string; source: string;
  config: BoatDriverConfig; environmentId: string; seenAt: number };
export interface SshOffloadRuntimeDeps {
  state: StateClientLike;
  logger: OffloadLogger;
  ssh: SshManager;
  accountId: string;
  // Boundary test seams: real SSH is still used, not an injected guest mock.
  boat?: (config: BoatDriverConfig) => BoatApiLike;
  session?: (sandboxId: string) => Promise<SshSession>;
  guestOptions?: Pick<SshOffloadGuestDeps, "executable" | "args" | "path" | "stateRoot" | "uvVenvRoot" | "cargoToolchain">;
  /** Tracked-file listing for admission; defaults to the real git listing. Test seam for non-git fixtures. */
  trackedFiles?: TrackedFilesFn;
}
/** Registry credential files: never synced, and their presence keeps commands local. */
export const REGISTRY_CREDENTIAL_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", "pip.conf", ".netrc"];

/** Secret-bearing names beyond registry config: never synced, and their presence keeps commands local. */
const STAY_LOCAL_EXACT = [".envrc", ".dev.vars", ".git-credentials"];
const STAY_LOCAL_DIRS = new Set([".aws", ".docker", ".kube"]);

/** Basename test mirroring the sync-exclude globs for secret-bearing files. */
function isSecretBearingName(name: string): boolean {
  if (STAY_LOCAL_EXACT.includes(name)) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".tfvars")) return true;
  if (name.startsWith("id_rsa") || name.startsWith("id_ed25519") || name.startsWith("id_ecdsa")) return true;
  if (name.includes(".tfstate")) return true;
  if (name.endsWith(".json") && (name.includes("credentials") || name.startsWith("service-account"))) return true;
  return false;
}

/** Sync-excluded directory names: never descended when looking for stay-local config. */
const SKIP_DIRS = new Set(
  DEFAULT_SYNC_EXCLUDES.filter((pattern) => pattern.endsWith("/")).map((pattern) => pattern.slice(0, -1)),
);

const MAX_CREDENTIAL_ENTRIES = 20_000;
const MAX_CREDENTIAL_DEPTH = 12;
const MAX_PYPROJECT_BYTES = 256 * 1024;

/** True when pyproject.toml carries uv auth: a [tool.uv] index/credential/auth
 * setting, or a [[tool.uv.index]] entry with credentials or a URL userinfo. */
function isUvAuthPyproject(text: string): boolean {
  const start = text.search(/\[\s*tool\.uv[\s.\]]/i);
  if (start < 0) return false;
  // Bound the uv section window; a later unrelated section cannot authorize a remote.
  const window = text.slice(start, start + 8_000);
  if (/password|username|token|credentials?|keyring|auth/i.test(window)) return true;
  if (/:\/\/[^/\s"']*@/.test(window)) return true;
  return false;
}

/** True when the source holds stay-local config at any depth: a registry
 * credential file (matched by basename, like the sync exclude), a uv.toml, a
 * pyproject.toml with uv auth, or any secret-bearing name or credential
 * directory (.aws/, .docker/, .kube/, *.pem, id_rsa*, ...). Bounded and skips
 * excluded dirs such as node_modules; unreadable or over-limit sources fail
 * closed to local. */
export async function hasRegistryCredentials(sourceRoot: string): Promise<boolean> {
  let entriesSeen = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sourceRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_CREDENTIAL_DEPTH) return true;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_CREDENTIAL_ENTRIES) return true;
      const name = entry.name;
      if (REGISTRY_CREDENTIAL_FILES.includes(name) || name === "uv.toml") return true;
      if (isSecretBearingName(name)) return true;
      if (entry.isDirectory() && STAY_LOCAL_DIRS.has(name)) return true;
      if (name === "pyproject.toml") {
        try {
          const abs = path.join(dir, name);
          const info = await lstat(abs);
          // Never follow symlinks for config this scan reads: consistent
          // with the sync symlink policy, a symlinked pyproject stays local
          // without touching its target (link size must not stand in for the
          // target, and the target must not be buffered unbounded).
          if (info.isSymbolicLink()) return true;
          // A FIFO/socket/dir here would only fail later in captureSnapshot
          // (SYNC_SPECIAL_FILE) after a VM was reserved, so stay local now.
          if (!info.isFile()) return true;
          if (info.size > MAX_PYPROJECT_BYTES) return true;
          const handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
          try {
            const target = await handle.stat();
            if (target.isSymbolicLink() || !target.isFile()) return true;
            if (target.size > MAX_PYPROJECT_BYTES) return true;
            const buf = Buffer.alloc(MAX_PYPROJECT_BYTES + 1);
            let off = 0;
            for (;;) {
              const { bytesRead } = await handle.read(buf, off, buf.length - off);
              if (bytesRead === 0) break;
              off += bytesRead;
              if (off > MAX_PYPROJECT_BYTES) return true;
            }
            if (isUvAuthPyproject(buf.subarray(0, off).toString("utf8"))) return true;
          } finally {
            await handle.close().catch(() => undefined);
          }
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push({ dir: path.join(dir, name), depth: depth + 1 });
      }
      // Symlinks are never followed: a matching basename above already stays
      // local, and anything else is left for the sync lstat guard.
    }
  }
  return false;
}

/** Cargo config that an --offline guest fetch from crates.io could not satisfy.
 * A `[registries.*]` table, a source replacement, or a stored credential/token
 * means the lockfile's deps may need private auth, so the command stays local.
 * Symlinked configs are never read; an unreadable or over-limit file also stays
 * local. Only host-authored source roots are scanned, never agent input. */
const CARGO_REGISTRY_AUTH_MARKERS = [/^\s*\[registries[\s.\]]/m, /^\s*replace-with\s*=/m, /credential-provider/i, /^\s*token\s*=/m];
const MAX_CARGO_CONFIG_BYTES = 64 * 1024;
const MAX_CARGO_CONFIG_DEPTH = 32;

export async function hasCargoRegistryAuth(sourceRoot: string, cwdRelative: string): Promise<boolean> {
  // Cargo discovers config from the command directory upward, so walk from the
  // cwd to the source root; the step cap bounds hostile nesting depth. Fail
  // closed throughout: an escaping cwd, a symlinked ancestor, or an exhausted
  // depth budget all keep the command local.
  const root = path.normalize(sourceRoot);
  const normalized = path.normalize(cwdRelative);
  // Route validation already rejects backslashes; the scan stays unreachable
  // for them by refusing them too, so a Windows-style escape never scans sideways.
  if (path.isAbsolute(normalized) || normalized.includes("\\") || normalized.split(path.sep).includes("..")) return true;
  let dir = normalized === "." ? root : path.join(root, normalized);
  for (let steps = 0; ; steps += 1) {
    // Ancestor directories are host-authored; a symlinked one could redirect
    // the scan outside the source root, so never descend through one. A
    // missing directory holds no config; keep scanning its parents.
    try {
      if ((await lstat(dir)).isSymbolicLink()) return true;
    } catch {
      // Fall through to the parent below.
    }
    // The .cargo component gets the same check: O_NOFOLLOW below guards only
    // the final component, so a symlinked .cargo would redirect the scan
    // outside the source root. A missing one holds no config at this level.
    let cargoDir = null;
    try {
      cargoDir = await lstat(path.join(dir, ".cargo"));
    } catch {
      // No .cargo here; keep scanning parents.
    }
    if (cargoDir !== null && (cargoDir.isSymbolicLink() || !cargoDir.isDirectory())) return true;
    for (const name of cargoDir === null ? [] : [".cargo/config.toml", ".cargo/config"]) {
      const abs = path.join(dir, name);
      let info;
      try {
        info = await lstat(abs);
      } catch {
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CARGO_CONFIG_BYTES) return true;
      let handle;
      try {
        handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      } catch {
        return true;
      }
      try {
        const target = await handle.stat();
        if (target.isSymbolicLink() || !target.isFile() || target.size > MAX_CARGO_CONFIG_BYTES) return true;
        const buf = Buffer.alloc(MAX_CARGO_CONFIG_BYTES + 1);
        let off = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buf, off, buf.length - off);
          if (bytesRead === 0) break;
          off += bytesRead;
          if (off > MAX_CARGO_CONFIG_BYTES) return true;
        }
        const text = buf.subarray(0, off).toString("utf8");
        if (CARGO_REGISTRY_AUTH_MARKERS.some((marker) => marker.test(text))) return true;
      } catch {
        return true;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    if (dir === root) return false;
    // Reaching the step cap below the source root means an adversary-deep (or
    // cyclic) tree the scan cannot fully cover: stay local.
    if (steps >= MAX_CARGO_CONFIG_DEPTH) return true;
    dir = path.dirname(dir);
    if (dir !== root && path.relative(root, dir).startsWith("..")) return true;
  }
}

/** Profile by id; unknown ids never resolve. */
function profileForId(profileId: string): ServerProfile | null {
  if (profileId === V1_PROFILE.id) return V1_PROFILE;
  if (profileId === NODE_PROFILE.id) return NODE_PROFILE;
  if (profileId === PYTHON_PROFILE.id) return PYTHON_PROFILE;
  return null;
}

/** Server-owned guest build env for a command's profile; Node/Python stay empty. */
export function profileGuestEnv(command: OffloadCommand): Record<string, string> {
  if ((command.tool ?? "cargo") !== "cargo") return {};
  return { ...(profileForId(command.profileId)?.env ?? {}) };
}

/** Path-bearing flags whose values must resolve inside the workspace. */
const PATH_FLAGS = ["--config", "--rootdir", "--prefix", "--cwd", "--dir", "--cache-dir", "-C", "--target-dir", "--out-dir"];

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const key = (company: string, run: string, workspace: string) => JSON.stringify([company, run, workspace]);
const plain = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");

/** The SDK has no CAS/list port. Serialize this worker's writes and maintain a
 * credential-free key index; index-before-record makes a partial write fail
 * closed on recovery. The plugin runs one worker, like its existing pool store. */
function journalStore(state: StateClientLike, companyId: string, poolId: string): OffloadStore {
  const scope = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: `boat-executor-${poolId}`, stateKey });
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = tail.then(operation);
    tail = pending.catch(() => undefined);
    return pending;
  };
  const keys = async (): Promise<string[]> => {
    const value = await state.get(scope("index"));
    if (value === null) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Invalid offload journal index");
    return value;
  };
  const put = async (id: string, value: unknown) => {
    const index = await keys();
    if (!index.includes(id)) await state.set(scope("index"), [...index, id]);
    await state.set(scope(id), value);
  };
  return {
    get: (id) => state.get(scope(id)),
    set: (id, value) => serialized(() => put(id, value)),
    create: (id, value) => serialized(async () => {
      if (await state.get(scope(id)) !== null) return false;
      await put(id, value); return true;
    }),
    delete: (id) => serialized(async () => {
      await state.delete(scope(id));
      await state.set(scope("index"), (await keys()).filter((item) => item !== id));
    }),
    list: (prefix) => serialized(async () => (await keys()).filter((id) => id.startsWith(prefix))),
  };
}

/** Every pool a company ever ran, so retention reaches pools no live command resolves again (e.g. after a restart). */
type PoolRegistry = Record<string, { artifactRoot: string; seenAt: number }>;
const poolRegistryScope = (companyId: string) =>
  ({ scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" });

export class SshOffloadRuntime {
  private readonly bindings = new Map<string, Binding>();
  private readonly pools = new Map<string, { companyId: string; artifactRoot: string; executor: OffloadExecutor; guest: SshOffloadGuest; sync: SshOffloadSync }>();
  /** Retention of an unloaded pool in progress: resolve waits before loading that pool's journal. */
  private readonly retiredSweeps = new Map<string, Promise<void>>();
  private registryTail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  constructor(private readonly deps: SshOffloadRuntimeDeps) {}

  /** True when this run/workspace already has a native binding (whole-run realization wins). */
  has(companyId: string, runId: string, workspaceId: string): boolean {
    return this.bindings.has(key(companyId, runId, workspaceId));
  }

  /** Drop every binding of a finished run so its commands read as permanently terminal. Returns the workspace ids dropped. */
  forgetRun(companyId: string, runId: string): string[] {
    const dropped: string[] = [];
    for (const [id, entry] of this.bindings) {
      if (entry.companyId === companyId && entry.runId === runId) { this.bindings.delete(id); dropped.push(entry.workspaceId); }
    }
    return dropped;
  }

  remember(params: PluginEnvironmentRealizeWorkspaceParams): void {
    const request = object(params.workspace.metadata?.workspaceRealizationRequest);
    const source = object(request?.source);
    if (!request || !source || request.version !== 1 || request.companyId !== params.companyId
      || request.environmentId !== params.environmentId || !plain(request.heartbeatRunId) || !plain(request.executionWorkspaceId)
      || !plain(source.localPath) || !path.isAbsolute(source.localPath) || source.localPath !== params.workspace.localPath) return;
    const config = parseDriverConfig(params.config);
    this.bindings.set(key(params.companyId, request.heartbeatRunId, request.executionWorkspaceId), {
      companyId: params.companyId, runId: request.heartbeatRunId, workspaceId: request.executionWorkspaceId,
      source: source.localPath, repoId: canonicalRepoId({ repoUrl: plain(source.repoUrl) ? source.repoUrl : null,
        projectId: plain(source.projectId) ? source.projectId : request.executionWorkspaceId }),
      config, environmentId: params.environmentId, seenAt: Date.now(),
    });
  }

  async resolve(command: BackendCommand, settings: Record<string, unknown>) {
    if (this.closing || settings.offloadExecutorEnabled !== true || settings.offloadGuestTransportEnabled !== true
      || !plain(settings.offloadCgroupParent) || !settings.offloadCgroupParent.startsWith("/sys/fs/cgroup/")
      || !plain(settings.offloadArtifactRoot) || !path.isAbsolute(settings.offloadArtifactRoot)
      || !Array.isArray(settings.offloadAllowedRepos) || !settings.offloadAllowedRepos.includes(command.repoId)) return null;
    const binding = this.bindings.get(key(command.companyId, command.runId, command.executionWorkspaceId));
    if (!binding || Date.now() - binding.seenAt > 24 * 60 * 60_000 || binding.repoId !== command.repoId) return null;
    const profile = profileForId(command.profileId);
    if (!profile || !normalizeOffloadSettings(settings).offloadProfiles.includes(profile.id)) return null;
    const tool = command.tool ?? (profile.id === V1_PROFILE.id ? "cargo" : profile.id === NODE_PROFILE.id ? "node" : "python");
    const runner = command.runner ?? defaultRunnerFor(tool);
    const runners = profile.id === V1_PROFILE.id ? ["cargo"] : profile.id === NODE_PROFILE.id ? NODE_PROFILE.runners! : PYTHON_PROFILE.runners!;
    if (!runners.includes(runner)) return null;
    // Cargo re-reads the toolchain pin from the host-owned source, not the route's view.
    const classified = tool === "cargo" ? await classifyCargoWorkspace(V1_PROFILE, command.argv, binding.source, command.cwdRelative)
      : tool === "node" ? classifyNode(runner, command.argv, profile)
      : classifyPython(runner, command.argv, profile);
    if (classified.mode !== "remote_candidate" || classified.profileId !== profile.id) return null;
    if (!this.confined(command, tool)) return null;
    // The guest runs in the mirrored cwd: an empty or sync-excluded directory
    // is absent there, so the command could not start remotely.
    if (!await snapshotHasDirectory(binding.source, command.cwdRelative).catch(() => false)) return null;
    // Tracked files only, for every tool: a non-git source, an empty index,
    // or a tracked file carrying a known credential shape keeps the command
    // local before any VM is reserved. The push re-checks both (the tree can
    // change after admission); this gate keeps a secret-bearing or untracked
    // workspace from ever spending a VM.
    const tracked = await (this.deps.trackedFiles ?? listTrackedFiles)(binding.source).catch(() => null);
    if (!tracked || tracked.size === 0) return null;
    const syncable = [...tracked].filter((rel) => !isDefaultSyncExcluded(rel));
    if (syncable.length === 0) return null;
    // A tracked secret-bearing name (a public test cert, a .docker/ context)
    // is withheld from sync, so the guest tree would silently lack a file the
    // build may read: stay local for every tool, cargo included.
    if ([...tracked].some((rel) => { const parts = rel.split("/");
      return isSecretBearingName(parts.at(-1)!) || parts.some((part) => STAY_LOCAL_DIRS.has(part)); })) return null;
    // Git lists normalized paths: "./src" or "src/." name the same directory.
    const cwd = path.posix.normalize(command.cwdRelative).replace(/\/$/, "");
    if (cwd !== "." && !syncable.some((rel) => rel.startsWith(`${cwd}/`))) return null;
    if (await hasSecretInFiles(binding.source, syncable).catch(() => true)) return null;
    // An --offline build cannot download missing crates: a private-registry
    // config in the source would fail the guest fetch, so the command stays
    // local. This is prepare-time's stay-local decision; the guest cannot see
    // the host source once the command is admitted.
    if (tool === "cargo" && isCargoOffline(command.argv)
      && await hasCargoRegistryAuth(binding.source, command.cwdRelative).catch(() => true)) return null;
    if (tool !== "cargo") {
      // No lockfile, no remote: the guest only installs from a lockfile and
      // never from an unlocked manifest. A registry credential file also
      // stays local: its token is excluded from sync, so the guest could not
      // authenticate a private registry without it.
      const plan = await planDependencies(binding.source, tool).catch(() => null);
      if (!plan) return null;
      if (await nestedLockfile(binding.source, command.cwdRelative, tool).catch(() => "unreadable") !== null) return null;
      if (await hasRegistryCredentials(binding.source).catch(() => true)) return null;
    }
    // Source and credentials only from host-authored native params. An API
    // caller cannot choose a host root, provider endpoint, executable or pool.
    if (await realpath(binding.source).catch(() => null) !== binding.source || this.closing || !resolveApiKey(binding.config)) return null;
    const poolId = createHash("sha256").update(JSON.stringify([binding.companyId, binding.environmentId, binding.repoId,
      command.profileId, binding.config.apiBase, binding.config.size, settings.offloadCgroupParent, settings.offloadArtifactRoot]))
      .digest("hex").slice(0, 24);
    // Neither template selection is deliberately part of the pool identity:
    // changing it must keep ownership of VMs already recorded under this pool
    // so they are retired through the normal stop path. The executor keys VM
    // reuse on the template instead (compatibilityKey).
    let existing = this.pools.get(poolId);
    if (!existing && this.retiredSweeps.has(poolId)) {
      await this.retiredSweeps.get(poolId);
      existing = this.pools.get(poolId);
    }
    if (existing) {
      existing.executor.setTemplateSnapshot(binding.config.templateSnapshot ?? null);
      existing.executor.setTemplateSourceSandboxId(binding.config.templateSourceSandboxId ?? null);
      return existing.executor;
    }
    const api = this.deps.boat?.(binding.config) ?? boatApi({ apiKey: resolveApiKey(binding.config)!, apiBase: binding.config.apiBase });
    const sessions = new Map<string, SshSession>();
    const session = this.deps.session ?? (async (sandboxId: string) => {
      const cached = sessions.get(sandboxId);
      if (cached) return cached;
      await waitReady(api, sandboxId, { timeoutMs: binding.config.timeoutMs });
      const sshKey = await this.deps.ssh.ensureKey();
      const response = await api.sshKey({ sandboxId, key: sshKey.publicKey });
      const opened = await this.deps.ssh.openSession({ sandboxId, endpoint: endpointFromSshKeyResponse(response), tunnel: null,
        connectTimeoutSec: binding.config.sshConnectTimeoutSec });
      sessions.set(sandboxId, opened);
      return opened;
    });
    const sourceRoot = async (cmd: OffloadCommand) => {
      const native = this.bindings.get(key(cmd.companyId, cmd.runId, cmd.executionWorkspaceId ?? ""));
      if (!native || native.repoId !== cmd.repoId || native.environmentId !== binding.environmentId) throw new Error("Native offload binding unavailable");
      return native.source;
    };
    const sync = new SshOffloadSync({ ssh: this.deps.ssh, session, sourceRoot, trackedFiles: this.deps.trackedFiles, artifactRoot: settings.offloadArtifactRoot,
      workRoot: this.deps.guestOptions?.stateRoot,
      // Warm commands reuse the cached session and its control master. After a
      // resume (new machine, IP and host key) the first guest op fails on the
      // stale session, and push re-authorizes exactly once through this refresh.
      refreshSession: async (sandboxId: string) => { sessions.delete(sandboxId); return session(sandboxId); } });
    const uvVenvRoot = async (cmd: OffloadCommand): Promise<string | null> => {
      if ((cmd.tool ?? "cargo") !== "python") return null;
      const native = this.bindings.get(key(cmd.companyId, cmd.runId, cmd.executionWorkspaceId ?? ""));
      if (!native || native.repoId !== cmd.repoId || native.environmentId !== binding.environmentId) return null;
      const plan = await planDependencies(native.source, cmd.tool).catch(() => null);
      if (!plan?.installs.some((item) => item.lockfile === "uv.lock")) return null;
      return sync.directory(cmd);
    };
    const guest = new SshOffloadGuest({ ssh: this.deps.ssh, session, cgroupParent: settings.offloadCgroupParent,
      workspace: (vm, cmd) => sync.cwd(vm, cmd),
      allowedEnv: (cmd) => ((cmd.tool ?? "cargo") === "cargo" ? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"] : []),
      profileEnv: profileGuestEnv,
      uvVenvRoot,
      cargoToolchain: (cmd) => cargoToolchain(cmd.argv, profile.toolchains),
      ...this.deps.guestOptions });
    // Sync-in begins every reservation, including resumed VMs. Sessions stay
    // cached across warm commands; push refreshes a stale session once through
    // the provider before retrying the transfer.
    const executor = new OffloadExecutor({ boat: api, state: this.deps.state, accountId: this.deps.accountId, poolId,
      logger: this.deps.logger, now: Date.now,
      config: { maxOffloadVms: binding.config.maxOffloadVms, offloadIdleStopSeconds: binding.config.offloadIdleStopSeconds,
        size: binding.config.size, maxActive: binding.config.maxActive, maxStartsPerDay: binding.config.maxStartsPerDay,
        minComputeHoursLeft: binding.config.minComputeHoursLeft,
        offloadMonthlyVmHourCap: normalizeOffloadSettings(settings).offloadMonthlyVmHourCap,
        templateSnapshot: binding.config.templateSnapshot ?? null,
        templateSourceSandboxId: binding.config.templateSourceSandboxId ?? null },
      guest, runCommand: (vm, cmd, context) => guest.runCommand(vm, cmd, context),
      recordDuration: async (cmd, seconds) => {
        // Completed remote Node/Python runs teach the duration gate. Rust is
        // never gated and is not recorded.
        const tool = cmd.tool ?? "cargo";
        if (tool === "cargo") return;
        const scope = { scopeKind: "company" as const, scopeId: cmd.companyId, namespace: "boat-offload", stateKey: "" };
        const key = durationKey(cmd.repoId, cmd.profileId, normalizeSignature(tool, cmd.runner ?? defaultRunnerFor(tool), cmd.argv, cmd.cwdRelative));
        try {
          await recordDuration({ get: (id) => this.deps.state.get({ ...scope, stateKey: id }),
            set: (id, value) => this.deps.state.set({ ...scope, stateKey: id }, value) }, key, { seconds, at: Date.now() });
        } catch {
          // Telemetry only; the command already completed.
        }
      },
      journalStore: journalStore(this.deps.state, command.companyId, poolId),
      guestReceipts: { bootId: (vm) => guest.bootId(vm), read: (identity) => guest.receipt(identity) },
      resolveRunState: async (companyId, runId) => ({
        permanentlyTerminal: this.runEnded(companyId, runId), terminatedAt: null, tokenExpiresAt: binding.seenAt + 24 * 60 * 60_000,
      }),
      sync: { push: (vm, cmd) => sync.push(vm, cmd),
        collect: (vm, cmd) => sync.collect(vm, cmd), stage: (vm, cmd, collected) => sync.stage(vm, cmd, collected),
        discard: (vm, cmd) => sync.discard(vm, cmd) },
    });
    this.pools.set(poolId, { companyId: command.companyId, artifactRoot: settings.offloadArtifactRoot, executor, guest, sync });
    // Bookkeeping only, never awaited (the queue can sit behind a sweep): a
    // lost write is retried by every sweep while the pool is loaded.
    void this.updateRegistry(command.companyId, (registry) => {
      registry[poolId] = { artifactRoot: settings.offloadArtifactRoot as string, seenAt: Date.now() };
    }).catch(() => undefined);
    return executor;
  }

  private runEnded(companyId: string, runId: string): boolean {
    return this.closed || ![...this.bindings.values()].some((entry) => entry.companyId === companyId && entry.runId === runId && Date.now() - entry.seenAt < 24 * 60 * 60_000);
  }

  private updateRegistry(companyId: string, change: (registry: PoolRegistry) => void | Promise<void>): Promise<void> {
    const pending = this.registryTail.then(async () => {
      const raw = await this.deps.state.get(poolRegistryScope(companyId));
      const registry: PoolRegistry = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as PoolRegistry) } : {};
      await change(registry);
      await this.deps.state.set(poolRegistryScope(companyId), registry);
    });
    this.registryTail = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Retention for a registered pool that is not loaded: its journal's
   * tombstones age out exactly as a loaded pool's would. The journal is never
   * executed, so only collectGarbage is reachable. Returns true once the
   * journal is empty.
   */
  private async collectRetiredPool(companyId: string, poolId: string, seenAt: number): Promise<boolean> {
    const store = journalStore(this.deps.state, companyId, poolId);
    const inert = async () => { throw new Error("Retired offload pool is not executable"); };
    const journal = new OffloadJournal({ journalStore: store, guestReceipts: { read: inert },
      resolveRunState: async (company, runId) => ({ permanentlyTerminal: this.runEnded(company, runId), terminatedAt: null,
        tokenExpiresAt: seenAt + 24 * 60 * 60_000 }),
      sync: { push: inert, collect: inert, stage: inert } }, Date.now, { hold: inert, release: inert, cancel: inert });
    await journal.collectGarbage();
    return (await store.list("")).length === 0;
  }

  private confined(command: BackendCommand, tool: "cargo" | "node" | "python"): boolean {
    if (path.posix.isAbsolute(command.cwdRelative) || command.cwdRelative.includes("\0") || LONE_SURROGATE.test(command.cwdRelative)
      || command.cwdRelative.split("/").some((part) => part === ".." || part === "")) return false;
    if (command.argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg) || LONE_SURROGATE.test(arg))) return false;
    if (tool === "cargo") {
      // V1 refuses all path-bearing Cargo overrides rather than guessing which
      // belong to the host or silently rewriting arguments. Relative cwd is enough.
      return !command.argv.some((arg) => /^(--(manifest-path|target-dir|out-dir|artifact-dir|lockfile-path)|-C)(=|$)/.test(arg));
    }
    // Node/Python: arbitrary inline code never goes remote, absolute host
    // paths are meaningless on the guest, and path-bearing flags must resolve
    // inside the workspace. Rust semantics above are unchanged.
    if ((command.runner === "python" || command.runner === "python3")
      && (command.argv[0] === "-c" || (command.argv.includes("-c") && !command.argv.includes("-m")))) return false;
    if (command.argv.some((arg) => path.posix.isAbsolute(arg) || /^[A-Za-z]:/.test(arg))) return false;
    const cwd = command.cwdRelative;
    for (let i = 0; i < command.argv.length; i++) {
      const arg = command.argv[i]!;
      const flag = PATH_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
      if (!flag) continue;
      const value = arg === flag ? (command.argv[i + 1] ?? "") : arg.slice(flag.length + 1);
      if (value === "" || value.startsWith("-")) continue;
      if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
      const resolved = path.posix.normalize(path.posix.join(cwd, value));
      if (resolved === ".." || resolved.startsWith("../")) return false;
    }
    return true;
  }

  /** Sweep loaded pools, then run retention for every registered pool of these companies that is not loaded. */
  async sweep(companyIds: Iterable<string> = []): Promise<void> {
    const outcomes = await Promise.allSettled([...this.pools.values()].map(async ({ executor, sync }) => {
      await executor.sweep();
      await executor.collectGarbage();
      await sync.collectGarbage();
    }));
    const companies = new Set([...companyIds, ...[...this.pools.values()].map((pool) => pool.companyId)]);
    let failed = false;
    const retired = await Promise.allSettled([...companies].map((companyId) => this.updateRegistry(companyId, async (registry) => {
      // (Re-)register loaded pools first: this retries a lost write from resolve.
      for (const [poolId, loaded] of this.pools) {
        if (loaded.companyId === companyId) registry[poolId] = { artifactRoot: loaded.artifactRoot, seenAt: Date.now() };
      }
      const roots = new Set<string>();
      for (const [poolId, entry] of Object.entries(registry)) {
        if (this.pools.has(poolId)) continue;
        if (!entry || typeof entry.artifactRoot !== "string" || !Number.isFinite(entry.seenAt)) { delete registry[poolId]; continue; }
        const task = this.collectRetiredPool(companyId, poolId, entry.seenAt);
        this.retiredSweeps.set(poolId, task.then(() => undefined, () => undefined));
        try {
          const empty = await task;
          roots.add(entry.artifactRoot);
          // Forget the pool once nothing of it is left to expire.
          if (empty && Date.now() - entry.seenAt >= ARTIFACT_RETENTION_MS) delete registry[poolId];
        } catch {
          // One unreadable pool must not starve the company's other pools.
          failed = true;
        } finally {
          this.retiredSweeps.delete(poolId);
        }
      }
      // A loaded pool's own sweep covers its root and spares its live uploads.
      const loadedRoots = new Set([...this.pools.values()].map((pool) => pool.artifactRoot));
      for (const root of roots) {
        if (!loadedRoots.has(root)) await sweepArtifactRoot(root, Date.now() - ARTIFACT_RETENTION_MS).catch(() => { failed = true; });
      }
    })));
    if (failed) throw new Error("Offload pool sweep unverified");
    if ([...outcomes, ...retired].some((outcome) => outcome.status === "rejected")) throw new Error("Offload pool sweep unverified");
  }

  async shutdown(): Promise<void> {
    // Fence both new and already-awaiting resolutions before taking the pool
    // snapshot. Keep run-state reads available while those pools drain.
    this.closing = true;
    await Promise.all([...this.pools.values()].map(async ({ executor, guest }) => {
      await executor.shutdown();
      await guest.shutdown();
    }));
    await this.registryTail;
    this.closed = true;
  }
}
