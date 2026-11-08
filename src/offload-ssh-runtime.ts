// Stock-worker integration. Authorization originates in native realization
// params, never an API body or execution.workspaces.read. Credentials remain in
// memory only; persisted executor state is credential-free and company scoped.
import { createHash, scrypt } from "node:crypto";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { promisify } from "node:util";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { boatApi, waitReady, type BoatApiLike } from "./boat-client.js";
import { parseDriverConfig, resolveApiKey, type BoatDriverConfig } from "./config.js";
import { AccountLedger } from "./account-ledger.js";
import { describeBoatError } from "./errors.js";
import { OffloadExecutor, type OffloadCommand, type OffloadLogger } from "./offload.js";
import { OffloadJournal, offloadError, type OffloadStore } from "./offload-journal.js";
import { OffloadPoolStore, type PoolVm } from "./offload-pool.js";
import { nestedLockfile, planDependencies } from "./offload/deps-install.js";
import { durationKey, normalizeSignature, pruneDurations, recordDuration } from "./offload/duration-history.js";
import { canonicalRepoId, classifyCargoWorkspace, defaultRunnerFor, normalizeOffloadSettings, NODE_PROFILE, PYTHON_PROFILE, V1_PROFILE, type ServerProfile } from "./offload/routes.js";
import { cargoToolchain, classifyNode, classifyPython, isCargoOffline } from "./offload/router.js";
import { LONE_SURROGATE } from "./offload/validate.js";
import type { BackendCommand, ExecutorRefusal } from "./offload/broker.js";
import type { StateClientLike } from "./state.js";
import { endpointFromSshKeyResponse, type SshManager, type SshSession } from "./ssh.js";
import { SshOffloadGuest, type SshOffloadGuestDeps } from "./offload-ssh.js";
import { ARTIFACT_RETENTION_MS, SshOffloadSync, checkDepSelection, sweepArtifactRoot } from "./offload-ssh-sync.js";
import { hasInitializedSubmodule, hasSecretInFiles, hasUntrackedFiles, listTrackedFiles, pemFilesAreCertificateOnly,
  type SubmodulesFn, type TrackedFilesFn, type UntrackedFilesFn } from "./offload-secret-scan.js";
import { DEFAULT_SYNC_EXCLUDES, isCertificatePemSyncCandidate, isDefaultSyncExcluded, snapshotHasDirectory } from "./offload-sync.js";
import { localSourceRoots, readGitOriginUrl, withinRoots } from "./local-run-binding.js";
import { SCRUB_BASHRC_ASCII_TOKEN, shellQuote } from "./shell.js";

/**
 * Removes boat's `export ASCII_TOKEN=...` line from the guest's ~/.bashrc once
 * per offload session, matching whole-run setup/resume. Best-effort: this
 * only stops casual use (the guest is root and can restore the line), so a
 * failure never fails the session.
 */
export async function scrubOffloadGuestBashrc(ssh: SshManager, session: SshSession): Promise<void> {
  await ssh.run(session, `sh -c ${shellQuote(SCRUB_BASHRC_ASCII_TOKEN)}`, { timeoutMs: 30_000 }).catch(() => undefined);
}

type Binding = { companyId: string; runId: string; workspaceId: string; repoId: string; source: string;
  config: BoatDriverConfig; environmentId: string; seenAt: number;
  /** Built by local-run binding from an agent-mutable workspace row: roots and repo identity re-validate per resolve. */
  localRun: boolean;
  /** Memoized KDF digest of the bind-time credential (memory only). A binding's
   * credential never changes mid-run, so the digest is computed once. */
  credentialDigest?: Promise<string> };

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Pool-identity version 1 scrypt parameters. The digest is baked into
 * persisted poolIds, so these values are part of pool identity forever:
 * changing any of them silently re-keys every pool and orphans its journals
 * and VMs into retirement. Do not change without a pool migration. They are
 * pinned explicitly rather than relying on Node's defaults, which could
 * change in a future Node release (they currently equal those defaults).
 */
const POOL_CREDENTIAL_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * The credential part of pool identity. The digest is persisted (inside the
 * poolId) but the key never is, so derive it with a password KDF rather than
 * a fast hash: a leaked pool journal then gives no cheap offline test for
 * guessed API keys. That protection covers the pool journal only — the
 * whole-run path still derives a persisted scope from the same key with a
 * fast hash (see `VmManager.account`), so this is not a system-wide
 * guarantee for every persisted derivation of the key. The salt binds the
 * digest to this purpose and endpoint.
 */
async function poolCredentialDigest(config: BoatDriverConfig): Promise<string> {
  const derived = await scryptAsync(
    resolveApiKey(config),
    `boat-offload-pool\u0000${config.apiBase}`,
    32,
    POOL_CREDENTIAL_SCRYPT_PARAMS,
  );
  return derived.toString("hex");
}
export interface SshOffloadRuntimeDeps {
  state: StateClientLike;
  logger: OffloadLogger;
  ssh: SshManager;
  accountId: string;
  // Boundary test seams: real SSH is still used, not an injected guest mock.
  boat?: (config: BoatDriverConfig) => BoatApiLike;
  session?: (sandboxId: string) => Promise<SshSession>;
  guestOptions?: Pick<SshOffloadGuestDeps, "executable" | "args" | "path" | "stateRoot" | "uvVenvRoot" | "cargoToolchain" | "delegationWait">;
  /** Tracked-file listing for admission; defaults to the real git listing. Test seam for non-git fixtures. */
  trackedFiles?: TrackedFilesFn;
  /** Untracked-file check for admission; defaults to the real git listing. Test seam for non-git fixtures. */
  untrackedFiles?: UntrackedFilesFn;
  /** Initialized-submodule check for admission; defaults to the real git listing. Test seam for non-git fixtures. */
  submodules?: SubmodulesFn;
}
/** Named stay-local reason when the source has untracked, non-ignored files. */
export const UNTRACKED_FILES_REASON = "untracked files present; running local";
/** Named stay-local reason when the source has an initialized submodule. */
export const SUBMODULES_REASON = "submodules present; running local";
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
 * closed to local. `verifiedCertPems` names tracked .pem paths already
 * proven certificate-only by the admission gate: those sync to the guest,
 * so their presence alone is not stay-local config. Any other .pem —
 * untracked included, since it would never reach the guest — still is. */
export async function hasRegistryCredentials(sourceRoot: string, verifiedCertPems: ReadonlySet<string> = new Set()): Promise<boolean> {
  let entriesSeen = 0;
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: sourceRoot, rel: "", depth: 0 }];
  while (stack.length > 0) {
    const { dir, rel, depth } = stack.pop()!;
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
      const entryRel = rel === "" ? name : `${rel}/${name}`;
      if (REGISTRY_CREDENTIAL_FILES.includes(name) || name === "uv.toml") return true;
      if (isSecretBearingName(name) && !verifiedCertPems.has(entryRel)) return true;
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
        stack.push({ dir: path.join(dir, name), rel: entryRel, depth: depth + 1 });
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

/** Server-owned guest build env; never copied from the host environment. */
export function profileGuestEnv(command: OffloadCommand): Record<string, string> {
  const profile = profileForId(command.profileId);
  if (profile?.tool !== (command.tool ?? "cargo")) return {};
  return { ...(profile?.env ?? {}) };
}

/** Path-bearing flags whose values must resolve inside the workspace. */
const PATH_FLAGS = ["--config", "--rootdir", "--prefix", "--cwd", "--dir", "--cache-dir", "-C", "--target-dir", "--out-dir"];

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const key = (company: string, run: string, workspace: string) => JSON.stringify([company, run, workspace]);
const plain = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");

/** The SDK has no CAS/list port. Serialize this worker's writes and maintain a
 * credential-free key index. The index is written before the record in both
 * put and delete: a crash then leaves either a dangling index entry (pruned
 * by journal recovery) or an orphan record (never listed, never wedging),
 * never the reverse. The plugin runs one worker, like its existing pool store. */
export function journalStore(state: StateClientLike, companyId: string, poolId: string): OffloadStore {
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
      await state.set(scope("index"), (await keys()).filter((item) => item !== id));
      await state.delete(scope(id));
    }),
    pruneDangling: (id) => serialized(async () => {
      // Re-read inside the tail: a concurrent put may have healed the entry
      // after the caller saw null. Only rewrite the index when still dangling.
      if (await state.get(scope(id)) !== null) return;
      await state.set(scope("index"), (await keys()).filter((item) => item !== id));
    }),
    list: (prefix) => serialized(async () => (await keys()).filter((id) => id.startsWith(prefix))),
  };
}

/** Every pool a company ever ran, so retention reaches pools no live command resolves again (e.g. after a restart). */
type PoolRegistry = Record<string, { artifactRoot: string; seenAt: number; credentialDigest?: string }>;
const poolRegistryScope = (companyId: string) =>
  ({ scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" });

export class SshOffloadRuntime {
  private readonly bindings = new Map<string, Binding>();
  /** Project-id aliases withdrawn because two execution workspaces of one run
   * claimed them with different sources; kept until the run is forgotten so a
   * re-realization cannot resurrect an ambiguous alias. */
  private readonly ambiguousAliases = new Set<string>();
  private readonly pools = new Map<string, { companyId: string; artifactRoot: string; credentialDigest: string; executor: OffloadExecutor; guest: SshOffloadGuest; sync: SshOffloadSync; sessions: Map<string, SshSession> }>();
  /** Credential-free pool identity (the poolId fields minus the credential
   * digest) to the live poolId, so a rotated or re-pointed API key presented
   * by a new binding retires the pool bound to the old credential instead of
   * silently reusing it. */
  private readonly poolByBaseIdentity = new Map<string, string>();
  /** Retention of an unloaded pool in progress: resolve waits before loading that pool's journal. */
  private readonly retiredSweeps = new Map<string, Promise<void>>();
  private registryTail: Promise<unknown> = Promise.resolve();
  /** Latest operator-configured local-run roots seen by resolve, per company.
   * Upload-time revalidation reads the pushing command's own company entry, so
   * dropping a root also refuses that company's pushes already queued — and
   * another company's config can neither cancel nor resurrect them. */
  private readonly localRunRootsByCompany = new Map<string, string[]>();
  private closing = false;
  private closed = false;
  constructor(private readonly deps: SshOffloadRuntimeDeps) {}

  /** True when this run/workspace already has a native binding (whole-run realization wins). */
  has(companyId: string, runId: string, workspaceId: string): boolean {
    return this.bindings.has(key(companyId, runId, workspaceId));
  }

  /** Read-only account clients from trusted bindings/configs or verified pool
   * provenance. Never resolve a company secret or invent a host-account binding. */
  async capacitySources(companyId: string, configs: BoatDriverConfig[] = []): Promise<Array<{ accountKey: string; api: BoatApiLike }>> {
    const sources = new Map<string, BoatApiLike>();
    const seenCredentials = new Set<string>(); // call-local only; never persisted or logged
    const candidates = [...configs, ...[...this.bindings.values()]
      .filter((binding) => binding.companyId === companyId).map((binding) => binding.config)];
    for (const config of candidates) {
      if (sources.size >= 8) break;
      // A keyless realization has not captured account provenance yet. A later
      // host-key rotation must not enroll its company in the new account.
      if (typeof config.apiKey !== "string" || !config.apiKey.trim()) continue;
      const bound = { ...config, apiKey: resolveApiKey(config) };
      const credential = `${bound.apiBase}\u0000${bound.apiKey}`;
      if (seenCredentials.has(credential)) continue;
      seenCredentials.add(credential);
      const digest = await poolCredentialDigest(bound);
      if (!sources.has(digest)) sources.set(digest, this.deps.boat?.(bound) ?? boatApi({ apiKey: bound.apiKey, apiBase: bound.apiBase }));
    }
    const registry = await this.deps.state.get(poolRegistryScope(companyId)) as PoolRegistry | null;
    for (const entry of Object.values(registry ?? {})) {
      if (sources.size >= 8) break;
      const digest = entry?.credentialDigest;
      if (typeof digest !== "string" || sources.has(digest)) continue;
      const api = await this.poolBoatFor(companyId, digest, () => configs);
      if (api) sources.set(digest, api);
    }
    return [...sources].map(([accountKey, api]) => ({ accountKey, api }));
  }

  /** Drop every binding of a finished run so its commands read as permanently terminal. Returns the workspace ids dropped. */
  forgetRun(companyId: string, runId: string): string[] {
    const dropped = new Set<string>();
    for (const [id, entry] of this.bindings) {
      if (entry.companyId === companyId && entry.runId === runId) { this.bindings.delete(id); dropped.add(entry.workspaceId); }
    }
    for (const id of this.ambiguousAliases) {
      const [company, run] = JSON.parse(id) as [string, string, string];
      if (company === companyId && run === runId) this.ambiguousAliases.delete(id);
    }
    return [...dropped];
  }

  remember(params: PluginEnvironmentRealizeWorkspaceParams): void {
    const request = object(params.workspace.metadata?.workspaceRealizationRequest);
    const source = object(request?.source);
    if (!request || !source || request.version !== 1 || request.companyId !== params.companyId
      || request.environmentId !== params.environmentId || !plain(request.heartbeatRunId) || !plain(request.executionWorkspaceId)
      || !plain(source.localPath) || !path.isAbsolute(source.localPath) || source.localPath !== params.workspace.localPath) return;
    const config = parseDriverConfig(params.config);
    const binding: Binding = {
      companyId: params.companyId, runId: request.heartbeatRunId, workspaceId: request.executionWorkspaceId,
      source: source.localPath, repoId: canonicalRepoId({ repoUrl: plain(source.repoUrl) ? source.repoUrl : null,
        projectId: plain(source.projectId) ? source.projectId : request.executionWorkspaceId }),
      config, environmentId: params.environmentId, seenAt: Date.now(), localRun: request.localRun === true,
    };
    const primaryKey = key(params.companyId, binding.runId, binding.workspaceId);
    const existingPrimary = this.bindings.get(primaryKey);
    // A local-run binding never replaces a whole-run one under the same key
    // (mirrors NativeOffloadWorkspaces).
    if (!(existingPrimary && !existingPrimary.localRun && binding.localRun)) {
      this.bindings.set(primaryKey, binding);
      this.ambiguousAliases.delete(primaryKey);
    }
    // The shim reports PAPERCLIP_WORKSPACE_ID, which carries the project
    // workspace id even for execution workspaces, so the same binding must
    // answer under that host-owned id too (mirrors NativeOffloadWorkspaces).
    if (plain(source.projectWorkspaceId) && source.projectWorkspaceId !== binding.workspaceId) {
      const aliasKey = key(params.companyId, binding.runId, source.projectWorkspaceId);
      const existing = this.bindings.get(aliasKey);
      if (this.ambiguousAliases.has(aliasKey) || (existing && !existing.localRun && binding.localRun)) {
        // Withdrawn ambiguity stays withdrawn; a whole-run alias is kept.
      } else if (!existing || (existing.localRun && !binding.localRun)
        || existing.source === binding.source || existing.workspaceId === binding.workspaceId) {
        this.bindings.set(aliasKey, binding);
      } else {
        // Two execution workspaces of this run claim the shared project id
        // with different checkouts, and the shim can only send that id:
        // withdraw the alias so resolution fails closed instead of silently
        // serving the later checkout.
        this.bindings.delete(aliasKey);
        this.ambiguousAliases.add(aliasKey);
      }
    }
    if (!binding.localRun) {
      // A local-run bind may have registered this same execution workspace
      // under a project alias this whole-run payload omits; whole-run
      // precedence covers that alias too, so claim it for the whole-run
      // binding instead of leaving the local checkout served under it
      // (mirrors NativeOffloadWorkspaces). Bindings of another execution
      // workspace are identified by their workspaceId and left alone.
      for (const [id, existing] of this.bindings) {
        if (id !== primaryKey && existing.companyId === binding.companyId && existing.runId === binding.runId
          && existing.workspaceId === binding.workspaceId && !this.ambiguousAliases.has(id)) {
          this.bindings.set(id, binding);
        }
      }
    }
  }

  /** Re-prove a local-run binding's operator-owned facts: the source still sits
   * under a configured root (and was not swapped for a symlink), and the
   * checkout's own origin still names the bound repo. */
  private async revalidateLocalRun(binding: Binding, roots: string[]): Promise<boolean> {
    if (roots.length === 0) return false;
    const canonical = await realpath(binding.source).catch(() => null);
    if (!canonical || canonical !== binding.source) return false;
    const canonicalRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => null))))
      .filter((root): root is string => root !== null);
    if (!withinRoots(canonical, canonicalRoots)) return false;
    const onDiskRepoUrl = await readGitOriginUrl(canonical).catch(() => null);
    return !!onDiskRepoUrl && canonicalRepoId({ repoUrl: onDiskRepoUrl, projectId: "" }) === binding.repoId;
  }

  /**
   * Every read-only pre-start gate, in dispatch order. Each refusal names its
   * site: the reason is journaled on the never-started receipt and printed by
   * the shim, so a local fallback is never silent. `resolve` runs this before
   * any pool/VM effect, and `preflight` exposes the same verdict to the
   * dry-run route so a `remote_candidate` answer is predictive for every gate
   * that can be checked without starting a VM.
   */
  private async gate(command: BackendCommand, settings: Record<string, unknown>):
    Promise<{ binding: Binding; profile: ServerProfile; cgroupParent: string; artifactRoot: string } | ExecutorRefusal> {
    const refuse = (refusalReason: string): ExecutorRefusal => ({ refusalReason });
    this.localRunRootsByCompany.set(command.companyId, localSourceRoots(settings));
    if (this.closing) return refuse("offload runtime is shutting down");
    if (settings.offloadExecutorEnabled !== true) return refuse("offload executor is not enabled");
    if (settings.offloadGuestTransportEnabled !== true) return refuse("offload guest transport is not enabled");
    if (!plain(settings.offloadCgroupParent) || !settings.offloadCgroupParent.startsWith("/sys/fs/cgroup/")) {
      return refuse("offload cgroup parent is not configured");
    }
    if (!plain(settings.offloadArtifactRoot) || !path.isAbsolute(settings.offloadArtifactRoot)) {
      return refuse("offload artifact root is not configured");
    }
    if (!Array.isArray(settings.offloadAllowedRepos) || !settings.offloadAllowedRepos.includes(command.repoId)) {
      return refuse("repo is not on the offload allowlist");
    }
    const binding = this.bindings.get(key(command.companyId, command.runId, command.executionWorkspaceId));
    if (!binding) return refuse("no offload binding for this run and workspace");
    if (Date.now() - binding.seenAt > 24 * 60 * 60_000) return refuse("offload binding for this run has expired");
    if (binding.repoId !== command.repoId) return refuse("offload binding repo does not match the workspace repo");
    // The workspace row behind a local-run binding is agent-mutable, so the
    // operator-owned facts are re-proven on every resolve, not only at bind.
    if (binding.localRun && !await this.revalidateLocalRun(binding, this.localRunRootsByCompany.get(command.companyId) ?? [])) {
      return refuse("local-run source no longer passes roots/origin validation");
    }
    const profile = profileForId(command.profileId);
    if (!profile) return refuse(`unknown offload profile ${command.profileId}`);
    if (!normalizeOffloadSettings(settings).offloadProfiles.includes(profile.id)) {
      return refuse(`profile ${profile.id} is not enabled for offload`);
    }
    const tool = command.tool ?? (profile.id === V1_PROFILE.id ? "cargo" : profile.id === NODE_PROFILE.id ? "node" : "python");
    const runner = command.runner ?? defaultRunnerFor(tool);
    const runners = profile.id === V1_PROFILE.id ? ["cargo"] : profile.id === NODE_PROFILE.id ? NODE_PROFILE.runners! : PYTHON_PROFILE.runners!;
    if (!runners.includes(runner)) return refuse(`runner ${runner} is not allowed on profile ${profile.id}`);
    // Cargo re-reads the toolchain pin from the host-owned source, not the route's view.
    const classified = tool === "cargo" ? await classifyCargoWorkspace(V1_PROFILE, command.argv, binding.source, command.cwdRelative)
      : tool === "node" ? classifyNode(runner, command.argv, profile)
      : classifyPython(runner, command.argv, profile);
    if (classified.mode !== "remote_candidate") return refuse(`workload is not a remote candidate: ${classified.reason}`);
    if (classified.profileId !== profile.id) return refuse("classification profile does not match the command profile");
    if (!this.confined(command, tool)) return refuse("command escapes workspace confinement");
    // The guest runs in the mirrored cwd: an empty or sync-excluded directory
    // is absent there, so the command could not start remotely.
    if (!await snapshotHasDirectory(binding.source, command.cwdRelative).catch(() => false)) {
      return refuse("command directory is not present in the synced workspace");
    }
    // Tracked files only, for every tool: a non-git source, an empty index,
    // or a tracked file carrying a known credential shape keeps the command
    // local before any VM is reserved. The push re-checks both (the tree can
    // change after admission); this gate keeps a secret-bearing or untracked
    // workspace from ever spending a VM.
    const tracked = await (this.deps.trackedFiles ?? listTrackedFiles)(binding.source).catch(() => null);
    if (!tracked || tracked.size === 0) return refuse("workspace has no tracked files to sync");
    // The mirror is tracked-only, so an untracked, non-ignored file (a new
    // module before its first commit) would build on the host and be missing
    // on the guest: a false remote failure. Stay local; a git failure counts
    // as untracked (fail closed).
    if (await (this.deps.untrackedFiles ?? hasUntrackedFiles)(binding.source).catch(() => true)) {
      return refuse(UNTRACKED_FILES_REASON);
    }
    // Submodule contents never reach the guest (the mirror is the parent
    // index only), so a build that reads an initialized submodule would fail
    // remotely. Stay local; a git failure counts as present (fail closed).
    if (await (this.deps.submodules ?? hasInitializedSubmodule)(binding.source).catch(() => true)) {
      return refuse(SUBMODULES_REASON);
    }
    // A tracked secret-bearing name (a .docker/ context, a key file) is
    // withheld from sync, so the guest tree would silently lack a file the
    // build may read: stay local for every tool, cargo included. The one
    // exception is a tracked .pem whose only barrier is its name: proven
    // certificate-only below, its bytes are public certificates, so it
    // syncs like any other tracked file instead of going missing.
    const certPemCandidates: string[] = [];
    for (const rel of tracked) {
      const parts = rel.split("/");
      if (parts.some((part) => STAY_LOCAL_DIRS.has(part))) {
        return refuse("tracked secret-bearing file keeps the command local");
      }
      if (!isSecretBearingName(parts.at(-1)!)) continue;
      if (isCertificatePemSyncCandidate(rel)) {
        certPemCandidates.push(rel);
        continue;
      }
      return refuse("tracked secret-bearing file keeps the command local");
    }
    if (certPemCandidates.length > 0
      && !await pemFilesAreCertificateOnly(binding.source, certPemCandidates).catch(() => false)) {
      return refuse("tracked .pem file is not a verified public certificate; keeps the command local");
    }
    const certPems = new Set(certPemCandidates);
    const syncable = [...tracked].filter((rel) => !isDefaultSyncExcluded(rel) || certPems.has(rel));
    if (syncable.length === 0) return refuse("no tracked files are syncable");
    // Git lists normalized paths: "./src" or "src/." name the same directory.
    const cwd = path.posix.normalize(command.cwdRelative).replace(/\/$/, "");
    if (cwd !== "." && !syncable.some((rel) => rel.startsWith(`${cwd}/`))) {
      return refuse("command directory has no syncable tracked files");
    }
    if (await hasSecretInFiles(binding.source, syncable).catch(() => true)) {
      return refuse("tracked file content matches a credential shape; stays local");
    }
    // An --offline build cannot download missing crates: a private-registry
    // config in the source would fail the guest fetch, so the command stays
    // local. This is prepare-time's stay-local decision; the guest cannot see
    // the host source once the command is admitted.
    if (tool === "cargo" && isCargoOffline(command.argv)
      && await hasCargoRegistryAuth(binding.source, command.cwdRelative).catch(() => true)) {
      return refuse("cargo config needs private registry auth; stays local");
    }
    if (tool === "cargo" && command.depSelection !== undefined) {
      return refuse("explicit dependency selection is not valid for this command; stays local");
    }
    if (tool !== "cargo") {
      // No lockfile, no remote: the guest only installs from a lockfile and
      // never from an unlocked manifest. A registry credential file also
      // stays local: its token is excluded from sync, so the guest could not
      // authenticate a private registry without it.
      // The same selection reaches installation and venv discovery; a refused
      // selection never retries with the default plan.
      const checked = checkDepSelection(command, tool);
      if (!checked) return refuse("explicit dependency selection is not valid for this command; stays local");
      const plan = await planDependencies(binding.source, tool, checked.selection).catch(() => null);
      if (!plan) return refuse("no lockfile-based dependency plan; stays local");
      if (await nestedLockfile(binding.source, command.cwdRelative, tool).catch(() => "unreadable") !== null) {
        return refuse("nested lockfile below the workspace root; stays local");
      }
      if (await hasRegistryCredentials(binding.source, certPems).catch(() => true)) {
        return refuse("registry credential config present; stays local");
      }
    }
    // Source and credentials only from host-authored native params. An API
    // caller cannot choose a host root, provider endpoint, executable or pool.
    if (await realpath(binding.source).catch(() => null) !== binding.source) return refuse("offload source path is not canonical");
    if (this.closing) return refuse("offload runtime is shutting down");
    if (!resolveApiKey(binding.config)) return refuse("offload credential is not configured");
    return { binding, profile, cgroupParent: settings.offloadCgroupParent, artifactRoot: settings.offloadArtifactRoot };
  }

  /**
   * Dry-run verdict: the refusal reason `resolve` would return for this
   * command right now, or null when every read-only gate passes. Capacity and
   * pool admission are deliberately not promised here; those refusals still
   * surface as journaled reasons on the real submit.
   */
  async preflight(command: BackendCommand, settings: Record<string, unknown>): Promise<string | null> {
    const gated = await this.gate(command, settings);
    return "refusalReason" in gated ? gated.refusalReason : null;
  }

  async resolve(command: BackendCommand, settings: Record<string, unknown>): Promise<OffloadExecutor | ExecutorRefusal> {
    const gated = await this.gate(command, settings);
    if ("refusalReason" in gated) {
      this.deps.logger.info("boat: offload executor refused", {
        runId: command.runId, workspaceId: command.executionWorkspaceId, reason: gated.refusalReason,
      });
      return gated;
    }
    const { binding, profile, cgroupParent, artifactRoot } = gated;
    // The credential digest is part of pool identity: persisted executor state
    // stays credential-free (a KDF digest is not the key), and a rotated or
    // re-pointed key must not keep operating pools, journals or VMs under the
    // old account. A binding's config — credential included — is captured at
    // bind time, so rotation takes effect when a new binding presents the new
    // key (the next run or realization, or the first bind after a worker
    // restart), never by switching a live binding's credential mid-run. That
    // resolve retires the old credential's pool below instead of reusing it.
    binding.config = { ...binding.config, apiKey: resolveApiKey(binding.config) };
    binding.credentialDigest ??= poolCredentialDigest(binding.config)
      .catch((error: unknown) => { binding.credentialDigest = undefined; throw error; });
    const credentialDigest = await binding.credentialDigest;
    // The KDF await reopens the window the closing check above closed:
    // shutdown may have taken its pool snapshot while the digest was pending.
    // Re-fence here (and after every later await) so no executor can be
    // registered after that snapshot; from the last check to pools.set the
    // path is synchronous, so shutdown cannot interleave.
    if (this.closing) return { refusalReason: "offload runtime is shutting down" };
    const baseIdentity = JSON.stringify([binding.companyId, binding.environmentId, binding.repoId,
      command.profileId, binding.config.apiBase, binding.config.size, settings.offloadCgroupParent, settings.offloadArtifactRoot]);
    const poolId = createHash("sha256").update(JSON.stringify([baseIdentity, credentialDigest]))
      .digest("hex").slice(0, 24);
    const supersededPoolId = this.poolByBaseIdentity.get(baseIdentity);
    if (supersededPoolId && supersededPoolId !== poolId) {
      this.poolByBaseIdentity.delete(baseIdentity);
      const superseded = this.pools.get(supersededPoolId);
      if (superseded) {
        // Retire under the old credential while it may still work: sweep
        // stops its idle VMs. The pool stays loaded and registered, so its
        // journal is retained and ages out through collectRetiredPool; no
        // new resolve can reach it because its poolId embeds the old digest.
        await superseded.executor.sweep().catch(() => undefined);
        if (this.closing) return { refusalReason: "offload runtime is shutting down" };
      }
    }
    // Neither template selection is deliberately part of the pool identity:
    // changing it must keep ownership of VMs already recorded under this pool
    // so they are retired through the normal stop path. The executor keys VM
    // reuse on the template instead (compatibilityKey).
    let existing = this.pools.get(poolId);
    if (!existing && this.retiredSweeps.has(poolId)) {
      await this.retiredSweeps.get(poolId);
      if (this.closing) return { refusalReason: "offload runtime is shutting down" };
      existing = this.pools.get(poolId);
    }
    if (existing) {
      existing.executor.setTemplateSnapshot(binding.config.templateSnapshot ?? null);
      existing.executor.setTemplateSourceSandboxId(binding.config.templateSourceSandboxId ?? null);
      existing.executor.setEphemeralRepos(normalizeOffloadSettings(settings).offloadEphemeralRepos);
      existing.executor.setMonitoring(binding.config.monitoring);
      return existing.executor;
    }
    const api = this.deps.boat?.(binding.config) ?? boatApi({ apiKey: resolveApiKey(binding.config)!, apiBase: binding.config.apiBase });
    const sessions = new Map<string, SshSession>();
    // First-touch races share one opener per VM: concurrent guests warming
    // the same pool never authorize the key or open the session twice.
    const pending = new Map<string, Promise<SshSession>>();
    // Shutdown fences every new open, rechecked after each await: the worker
    // drains offload for a bounded time and then closes every session and
    // the key dir, so an open that is still running then must not recreate
    // the key, authorize it on the VM or start a control master afterwards.
    // A cached session stays usable for the commands still draining.
    const fence = () => {
      if (this.closing) throw offloadError("OFFLOAD_RUNTIME_CLOSING");
    };
    const session = this.deps.session ?? (async (sandboxId: string) => {
      const cached = sessions.get(sandboxId);
      if (cached) return cached;
      const ongoing = pending.get(sandboxId);
      if (ongoing) return ongoing;
      fence();
      const opening = (async (): Promise<SshSession> => {
        await waitReady(api, sandboxId, { timeoutMs: binding.config.timeoutMs });
        fence();
        const sshKey = await this.deps.ssh.ensureKey();
        fence();
        const response = await api.sshKey({ sandboxId, key: sshKey.publicKey });
        fence();
        const opened = await this.deps.ssh.openSession({ sandboxId, endpoint: endpointFromSshKeyResponse(response), tunnel: null,
          connectTimeoutSec: binding.config.sshConnectTimeoutSec });
        try {
          fence();
          // Once per opened session (sessions are cached; a refresh after resume
          // re-opens and re-scrubs), before any dependency install runs guest code.
          await scrubOffloadGuestBashrc(this.deps.ssh, opened);
          fence();
        } catch (error) {
          // Opened after the fence tripped (or never scrubbed): close it
          // rather than cache a master that shutdown has already passed.
          if (this.closing) await this.deps.ssh.closeSession(sandboxId).catch(() => undefined);
          throw error;
        }
        sessions.set(sandboxId, opened);
        return opened;
      })();
      pending.set(sandboxId, opening);
      try {
        return await opening;
      } finally {
        if (pending.get(sandboxId) === opening) pending.delete(sandboxId);
      }
    });
    const sourceRoot = async (cmd: OffloadCommand) => {
      const native = this.bindings.get(key(cmd.companyId, cmd.runId, cmd.executionWorkspaceId ?? ""));
      if (!native || native.repoId !== cmd.repoId || native.environmentId !== binding.environmentId) throw new Error("Native offload binding unavailable");
      // A queued command can snapshot long after resolve approved it, so a
      // local-run binding is re-proven again at upload time against the latest
      // roots configured for its own company. Throwing fails the push before
      // transport, which the journal records as not_started (fallback-safe,
      // runs locally).
      if (native.localRun && !await this.revalidateLocalRun(native, this.localRunRootsByCompany.get(cmd.companyId) ?? [])) {
        throw new Error("Local-run offload source no longer passes roots/origin validation");
      }
      return native.source;
    };
    // Warm commands reuse the cached session and its control master. After a
    // resume (new machine, IP and host key) the first guest op fails on the
    // stale session, and push re-authorizes exactly once through this refresh.
    // The guest preflight uses the same refresh, in a bounded backoff wait,
    // when its probe proves the session runs outside the delegated cgroup
    // parent (a master accepted by a pre-restart sshd listener never enters
    // the template's ForceCommand scope). Single-flight per VM, like the opener above:
    // concurrent refreshers share one reopen instead of each reopening
    // closing the master the other just started.
    const refreshing = new Map<string, Promise<SshSession>>();
    const refreshSession = async (sandboxId: string) => {
      const ongoing = refreshing.get(sandboxId);
      if (ongoing) return ongoing;
      // A refresh is always a new open: refuse it once shutdown began, even
      // when tests inject the opener.
      fence();
      const reopening = (async (): Promise<SshSession> => {
        sessions.delete(sandboxId);
        return session(sandboxId);
      })();
      refreshing.set(sandboxId, reopening);
      try {
        return await reopening;
      } finally {
        if (refreshing.get(sandboxId) === reopening) refreshing.delete(sandboxId);
      }
    };
    const sync = new SshOffloadSync({ ssh: this.deps.ssh, session, sourceRoot, trackedFiles: this.deps.trackedFiles, artifactRoot,
      workRoot: this.deps.guestOptions?.stateRoot,
      refreshSession });
    const uvVenvRoot = async (cmd: OffloadCommand): Promise<string | null> => {
      if ((cmd.tool ?? "cargo") !== "python") return null;
      const native = this.bindings.get(key(cmd.companyId, cmd.runId, cmd.executionWorkspaceId ?? ""));
      if (!native || native.repoId !== cmd.repoId || native.environmentId !== binding.environmentId) return null;
      const checked = checkDepSelection(cmd);
      if (!checked) return null;
      const plan = await planDependencies(native.source, cmd.tool, checked.selection).catch(() => null);
      if (!plan?.installs.some((item) => item.lockfile === "uv.lock")) return null;
      return sync.directory(cmd);
    };
    const guest = new SshOffloadGuest({ ssh: this.deps.ssh, session, refreshSession, cgroupParent,
      closing: () => this.closing,
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
        size: binding.config.size, monitoring: binding.config.monitoring, maxActive: binding.config.maxActive, maxStartsPerDay: binding.config.maxStartsPerDay,
        minComputeHoursLeft: binding.config.minComputeHoursLeft,
        offloadMonthlyVmHourCap: normalizeOffloadSettings(settings).offloadMonthlyVmHourCap,
        ephemeralRepos: normalizeOffloadSettings(settings).offloadEphemeralRepos,
        templateSnapshot: binding.config.templateSnapshot ?? null,
        templateSourceSandboxId: binding.config.templateSourceSandboxId ?? null },
      // A released VM's session is closed and forgotten; the next command
      // needing it re-opens on demand through the cached-session path.
      // A plain dep, not persisted config, so pool snapshots stay
      // structured-cloneable. Never throws: cleanup must not lose a receipt.
      onVmReleased: async (sandboxId: string) => {
        sessions.delete(sandboxId);
        await this.deps.ssh.closeSession(sandboxId).catch(() => undefined);
      },
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
            set: (id, value) => this.deps.state.set({ ...scope, stateKey: id }, value),
            delete: (id) => this.deps.state.delete({ ...scope, stateKey: id }) }, key, { seconds, at: Date.now() });
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
        discard: (vm, cmd) => sync.discard(vm, cmd), markSuspect: (vm, cmd) => sync.markSuspect(vm, cmd) },
    });
    this.pools.set(poolId, { companyId: command.companyId, artifactRoot, credentialDigest, executor, guest, sync, sessions });
    this.poolByBaseIdentity.set(baseIdentity, poolId);
    // Bookkeeping only, never awaited (the queue can sit behind a sweep): a
    // lost write is retried by every sweep while the pool is loaded.
    void this.updateRegistry(command.companyId, (registry) => {
      registry[poolId] = { artifactRoot: settings.offloadArtifactRoot as string, seenAt: Date.now(), credentialDigest };
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
      sync: { push: inert, collect: inert, stage: inert, markSuspect: inert } }, Date.now, { hold: inert, release: inert, cancel: inert });
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

  /** Only the recorded credential + endpoint may operate an unloaded pool.
   * A company-level client or a foreign account's 404 is never deletion proof.
   * Legacy unmarked pools wait until a verified resolve registers provenance. */
  private async poolBoatFor(companyId: string, digest: unknown,
    configsFor?: (companyId: string) => BoatDriverConfig[]): Promise<BoatApiLike | null> {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
    let configs: BoatDriverConfig[] = [];
    try { configs = configsFor?.(companyId) ?? []; } catch { /* try live bindings and the host */ }
    configs = [...configs, ...[...this.bindings.values()].filter((binding) => binding.companyId === companyId).map((binding) => binding.config),
      parseDriverConfig({})];
    for (const config of configs) {
      try {
        // Capture a host-resolved key before the KDF await, so rotation cannot
        // switch the provider client after the matching digest was computed.
        const bound = { ...config, apiKey: resolveApiKey(config) };
        if (await poolCredentialDigest(bound) !== digest) continue;
        return this.deps.boat?.(bound) ?? boatApi({ apiKey: bound.apiKey, apiBase: bound.apiBase });
      } catch { /* unavailable matching credentials leave the pool unknown */ }
    }
    return null;
  }

  /**
   * Upkeep for a registered pool that is not loaded: stop past-due VMs,
   * confirm stopping VMs, settle provider-gone VMs (journal to terminal-read
   * unknown, never replayed), then reconcile the ledger for that poolId.
   * Never creates a VM. An absent pool still needs ledger reconciliation;
   * an unreadable document throws so the sweep reports unverified.
   */
  private async sweepUnloadedPool(companyId: string, poolId: string, seenAt: number, boat: BoatApiLike): Promise<void> {
    const poolStore = new OffloadPoolStore(this.deps.state, this.deps.accountId, poolId);
    const ledger = new AccountLedger(this.deps.state, this.deps.accountId, Date.now);
    let doc;
    try {
      doc = await poolStore.loadDoc();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "OFFLOAD_POOL_ABSENT") throw error;
      // Reserve can commit before either pool save succeeds. This caller has
      // verified credential provenance; reconcile durable intents (including
      // id-less TTL holds), never infer provider deletion from pool absence.
      await ledger.reconcile(boat, undefined, false, false, poolId);
      return;
    }
    const pool = doc.vms;
    const inert = async (): Promise<never> => { throw new Error("Unloaded offload pool is not executable"); };
    const journal = new OffloadJournal({ journalStore: journalStore(this.deps.state, companyId, poolId),
      guestReceipts: { read: inert },
      resolveRunState: async (company, runId) => ({ permanentlyTerminal: this.runEnded(company, runId), terminatedAt: null,
        tokenExpiresAt: seenAt + 24 * 60 * 60_000 }),
      sync: { push: inert, collect: inert, stage: inert, markSuspect: inert } }, Date.now, { hold: inert, release: inert, cancel: inert });
    const now = Date.now();
    // Fields a concurrent claim changes; compared against a reload before
    // saving so the sweep never overwrites a reservation made from a snapshot
    // taken before this upkeep's fence existed.
    const fingerprint = (vm: PoolVm) => JSON.stringify([vm.busy, vm.generation, vm.stopping, vm.stopped, vm.quarantined, vm.stopDueAt]);
    // Placeholders without a provider ID key on their durable reservation,
    // which loadDoc guarantees unique; every other VM keys on its sandbox ID.
    const vmKey = (vm: PoolVm) => vm.sandboxId || vm.accountReservation?.id || "";
    const original = new Map(pool.map((vm) => [vmKey(vm), fingerprint(vm)]));
    const deletedIds = new Set<string>();
    let changed = false;
    let accountingFailed = false;
    for (const vm of [...pool]) {
      if (!vm.sandboxId) continue; // a lost create reply: no provider handle until a command resolves this pool
      let state: string | null = null;
      try {
        const response = (await boat.get({ sandboxId: vm.sandboxId })) as { sandbox?: { id?: unknown; state?: unknown } };
        state = response?.sandbox?.id === vm.sandboxId && typeof response.sandbox.state === "string" ? response.sandbox.state : null;
      } catch (error) {
        if ((await describeBoatError(error)).status === 404) state = "deleted";
        else continue; // unreadable: leave it, retry next sweep
      }
      if (state === null) continue;
      // The provider call awaited above lets a resolve interleave (one that
      // loaded the pool before this upkeep's fence existed): re-read this VM
      // and leave it alone when it changed under us, before any stop or save.
      const live = (await poolStore.loadDoc().catch(() => null))?.vms.find((entry) => vmKey(entry) === vmKey(vm));
      if (!live || fingerprint(live) !== original.get(vmKey(vm))) continue;
      if (["archived", "cancelled", "deleted"].includes(state)) {
        if (vm.stopObservedAt == null) { vm.stopObservedAt = now; changed = true; }
        try {
          await ledger.stopped(vm.sandboxId, vm.stopObservedAt, vm.accountReservation?.id);
        } catch {
          // Retain this slot's accounting retry anchor, but do not let its
          // write outage prevent other VMs from stopping or saving progress.
          accountingFailed = true;
          continue;
        }
        // Same rule as the loaded executor: a failed settlement keeps the
        // slot fenced for retry, never freed on an unsettled receipt.
        if (!await journal.settleSandboxUnknown(vm.sandboxId).then(() => true, () => false)) {
          if (!vm.quarantined) { vm.quarantined = true; changed = true; }
          continue;
        }
        if (state === "deleted") { pool.splice(pool.indexOf(vm), 1); deletedIds.add(vm.sandboxId); }
        else {
          vm.busy = false;
          vm.stopping = false;
          vm.stopped = true;
          vm.quarantined = false;
          vm.workspaceKey = null;
        }
        changed = true;
        continue;
      }
      if (!["ready", "idle", "running"].includes(state)) continue; // archiving and the like: retry next sweep
      if (vm.stopped) continue;
      const pastDue = vm.stopDueAt !== null && now >= vm.stopDueAt;
      // A fenced VM with no verifiable identity still bills: stop it past due
      // while it stays fenced, and the terminal observation above releases its
      // slot once Boat archives it. VMs with an identity need a guest observe
      // this path cannot do, so they wait for a loaded executor.
      if (!vm.stopping && !pastDue) continue;
      if (vm.quarantined && vm.identity) continue;
      try {
        await boat.stop({ sandboxId: vm.sandboxId });
      } catch { continue; }
      vm.stopRequestedAt ??= now;
      vm.stopping = true;
      changed = true;
    }
    if (changed) {
      // Re-read before saving: a resolve that loaded the pool before this
      // upkeep's fence existed may have reserved a VM meanwhile. Keep the
      // fresh copy of anything that changed under us (and never resurrect our
      // own delete over a fresh claim); only our untouched VMs save back. A
      // vanished or unreadable doc throws so the sweep reports unverified.
      const fresh = await poolStore.loadDoc();
      const twinById = new Map(fresh.vms.map((twin) => [vmKey(twin), twin]));
      const merged: PoolVm[] = [];
      const seen = new Set<string>();
      for (const vm of pool) {
        const id = vmKey(vm);
        const twin = twinById.get(id);
        if (!twin || fingerprint(twin) !== original.get(id)) {
          if (twin) { merged.push(twin); seen.add(id); }
          continue;
        }
        merged.push(vm);
        seen.add(id);
      }
      for (const twin of fresh.vms) {
        const id = vmKey(twin);
        if (seen.has(id)) continue;
        if (deletedIds.has(twin.sandboxId) && fingerprint(twin) === original.get(id)) continue;
        merged.push(twin);
      }
      await poolStore.save(fresh.config, merged);
    }
    await ledger.reconcile(boat, undefined, false, false, poolId);
    if (accountingFailed) throw new Error("Offload pool accounting incomplete");
  }

  /** Sweep loaded pools, then run retention for every registered pool of these companies that is not loaded. */
  async sweep(companyIds: Iterable<string> = [], opts: { configsFor?: (companyId: string) => BoatDriverConfig[] } = {}): Promise<void> {
    const outcomes = await Promise.allSettled([...this.pools.values()].map(async ({ executor, sync }) => {
      await executor.sweep();
      await executor.collectGarbage();
      await sync.collectGarbage();
    }));
    const companies = new Set([...companyIds, ...[...this.pools.values()].map((pool) => pool.companyId)]);
    // Duration-learning hygiene rides the same sweep: drop expired signature
    // keys and repair over-cap indexes. Telemetry-only; a failing prune must
    // not fail pool retention.
    for (const companyId of companies) {
      const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload", stateKey: "" };
      const durations = {
        get: (key: string) => this.deps.state.get({ ...scope, stateKey: key }),
        set: (key: string, value: unknown) => this.deps.state.set({ ...scope, stateKey: key }, value),
        delete: (key: string) => this.deps.state.delete({ ...scope, stateKey: key }),
      };
      await pruneDurations(durations, Date.now()).catch(() => undefined);
    }
    let failed = false;
    const retired = await Promise.allSettled([...companies].map((companyId) => this.updateRegistry(companyId, async (registry) => {
      // (Re-)register loaded pools first: this retries a lost write from resolve.
      for (const [poolId, loaded] of this.pools) {
        if (loaded.companyId === companyId) registry[poolId] = { artifactRoot: loaded.artifactRoot, seenAt: Date.now(), credentialDigest: loaded.credentialDigest };
      }
      const roots = new Set<string>();
      for (const [poolId, entry] of Object.entries(registry)) {
        if (this.pools.has(poolId)) continue;
        if (!entry || typeof entry.artifactRoot !== "string" || !Number.isFinite(entry.seenAt)) { delete registry[poolId]; continue; }
        // Upkeep before retention: a restarted worker stops past-due VMs and
        // settles provider-gone slots without waiting for a new command to
        // resolve this poolId. Without a client the pool waits, still covered
        // by retention below.
        const unloadedBoat = await this.poolBoatFor(companyId, entry.credentialDigest, opts.configsFor);
        if (this.pools.has(poolId)) continue; // resolve may have completed during the KDF
        if (unloadedBoat) {
          // Fence resolutions before upkeep starts and hold the fence through
          // provider calls and the save: resolve waits on retiredSweeps, so a
          // command cannot claim a VM from a stale snapshot mid-upkeep while
          // the sweep stops it, and the save cannot overwrite its reservation.
          let releaseFence: () => void = () => undefined;
          const fence = new Promise<void>((resolveFence) => { releaseFence = resolveFence; });
          this.retiredSweeps.set(poolId, fence);
          try {
            await this.sweepUnloadedPool(companyId, poolId, entry.seenAt, unloadedBoat);
          } catch {
            // Upkeep may have saved terminal VM flags before reconciliation
            // failed. Do not let retention erase its only durable retry anchor.
            failed = true;
            continue;
          } finally {
            releaseFence();
            this.retiredSweeps.delete(poolId);
          }
        }
        const task = this.collectRetiredPool(companyId, poolId, entry.seenAt);
        this.retiredSweeps.set(poolId, task.then(() => undefined, () => undefined));
        try {
          const empty = await task;
          roots.add(entry.artifactRoot);
          // An empty journal says nothing about provider liveness. Keep the
          // registry retry anchor for any still-billing or uncertain VM.
          if (empty && Date.now() - entry.seenAt >= ARTIFACT_RETENTION_MS) {
            const store = new OffloadPoolStore(this.deps.state, this.deps.accountId, poolId);
            const vms = await store.load().catch((error) => {
              if (error instanceof Error && error.message === "OFFLOAD_POOL_ABSENT") return [];
              throw error;
            });
            if (vms.every((vm) => vm.stopped && !vm.busy && !vm.stopping && !vm.quarantined)) {
              const ledger = new AccountLedger(this.deps.state, this.deps.accountId, Date.now);
              if (await ledger.poolAccountingSettled(poolId)) delete registry[poolId];
              else failed = true;
            }
          }
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
    // Sessions outlive executors only when their release hook never fired
    // (a pool created before the hook existed, or a VM deleted out-of-band):
    // runtime shutdown still closes what it cached. The worker-level
    // closeAll in BoatVmManager.shutdown remains the backstop for the rest.
    for (const { sessions } of this.pools.values()) {
      for (const sandboxId of [...sessions.keys()]) {
        sessions.delete(sandboxId);
        await this.deps.ssh.closeSession(sandboxId).catch(() => undefined);
      }
    }
    this.closed = true;
  }
}
