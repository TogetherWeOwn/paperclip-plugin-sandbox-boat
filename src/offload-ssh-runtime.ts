// Stock-worker integration. Authorization originates in native realization
// params, never an API body or execution.workspaces.read. Credentials remain in
// memory only; persisted executor state is credential-free and company scoped.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { boatApi, waitReady, type BoatApiLike } from "./boat-client.js";
import { parseDriverConfig, resolveApiKey, type BoatDriverConfig } from "./config.js";
import { OffloadExecutor, type OffloadCommand, type OffloadLogger } from "./offload.js";
import type { OffloadStore } from "./offload-journal.js";
import { planDependencies } from "./offload/deps-install.js";
import { durationKey, normalizeSignature, recordDuration } from "./offload/duration-history.js";
import { canonicalRepoId, defaultRunnerFor, normalizeOffloadSettings, NODE_PROFILE, PYTHON_PROFILE, V1_PROFILE, type ServerProfile } from "./offload/routes.js";
import { classifyCargo, classifyNode, classifyPython } from "./offload/router.js";
import { LONE_SURROGATE } from "./offload/validate.js";
import type { BackendCommand } from "./offload/broker.js";
import type { StateClientLike } from "./state.js";
import { endpointFromSshKeyResponse, type SshManager, type SshSession } from "./ssh.js";
import { SshOffloadGuest, type SshOffloadGuestDeps } from "./offload-ssh.js";
import { SshOffloadSync } from "./offload-ssh-sync.js";

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
  guestOptions?: Pick<SshOffloadGuestDeps, "executable" | "args" | "path" | "stateRoot">;
}
/** Profile by id; unknown ids never resolve. */
function profileForId(profileId: string): ServerProfile | null {
  if (profileId === V1_PROFILE.id) return V1_PROFILE;
  if (profileId === NODE_PROFILE.id) return NODE_PROFILE;
  if (profileId === PYTHON_PROFILE.id) return PYTHON_PROFILE;
  return null;
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

export class SshOffloadRuntime {
  private readonly bindings = new Map<string, Binding>();
  private readonly pools = new Map<string, { executor: OffloadExecutor; guest: SshOffloadGuest }>();
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
    const classified = tool === "cargo" ? classifyCargo(command.argv, V1_PROFILE)
      : tool === "node" ? classifyNode(runner, command.argv, profile)
      : classifyPython(runner, command.argv, profile);
    if (classified.mode !== "remote_candidate" || classified.profileId !== profile.id) return null;
    if (!this.confined(command, tool)) return null;
    if (tool !== "cargo") {
      // No lockfile, no remote: the guest only installs from a lockfile and
      // never from an unlocked manifest.
      const plan = await planDependencies(binding.source).catch(() => null);
      if (!plan) return null;
    }
    // Source and credentials only from host-authored native params. An API
    // caller cannot choose a host root, provider endpoint, executable or pool.
    if (await realpath(binding.source).catch(() => null) !== binding.source || this.closing || !resolveApiKey(binding.config)) return null;
    const poolId = createHash("sha256").update(JSON.stringify([binding.companyId, binding.environmentId, binding.repoId,
      command.profileId, binding.config.apiBase, binding.config.size, settings.offloadCgroupParent, settings.offloadArtifactRoot])).digest("hex").slice(0, 24);
    const existing = this.pools.get(poolId);
    if (existing) return existing.executor;
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
    const sync = new SshOffloadSync({ ssh: this.deps.ssh, session, sourceRoot, artifactRoot: settings.offloadArtifactRoot,
      workRoot: this.deps.guestOptions?.stateRoot });
    const guest = new SshOffloadGuest({ ssh: this.deps.ssh, session, cgroupParent: settings.offloadCgroupParent,
      workspace: (vm, cmd) => sync.cwd(vm, cmd),
      allowedEnv: (cmd) => ((cmd.tool ?? "cargo") === "cargo" ? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"] : []),
      ...this.deps.guestOptions });
    // Sync-in begins every reservation, including resumed VMs: discard stale
    // host-key/IP state and authorize via the provider before transferring.
    const executor = new OffloadExecutor({ boat: api, state: this.deps.state, accountId: this.deps.accountId, poolId,
      logger: this.deps.logger, now: Date.now,
      config: { maxOffloadVms: binding.config.maxOffloadVms, offloadIdleStopSeconds: binding.config.offloadIdleStopSeconds,
        size: binding.config.size, maxActive: binding.config.maxActive, maxStartsPerDay: binding.config.maxStartsPerDay,
        minComputeHoursLeft: binding.config.minComputeHoursLeft },
      guest, runCommand: (vm, cmd, context) => guest.runCommand(vm, cmd, context),
      recordDuration: async (cmd, seconds) => {
        // Completed remote Node/Python runs teach the duration gate. Rust is
        // never gated and is not recorded.
        const tool = cmd.tool ?? "cargo";
        if (tool === "cargo") return;
        const scope = { scopeKind: "company" as const, scopeId: cmd.companyId, namespace: "boat-offload", stateKey: "" };
        const key = durationKey(cmd.repoId, cmd.profileId, normalizeSignature(tool, cmd.runner ?? defaultRunnerFor(tool), cmd.argv));
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
        permanentlyTerminal: this.closed || ![...this.bindings.values()].some((entry) => entry.companyId === companyId && entry.runId === runId && Date.now() - entry.seenAt < 24 * 60 * 60_000),
        terminatedAt: null, tokenExpiresAt: binding.seenAt + 24 * 60 * 60_000,
      }),
      sync: { push: async (vm, cmd) => { sessions.delete(vm); await sync.push(vm, cmd); },
        collect: (vm, cmd) => sync.collect(vm, cmd), stage: (vm, cmd, collected) => sync.stage(vm, cmd, collected) },
    });
    this.pools.set(poolId, { executor, guest });
    return executor;
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
    if ((command.runner === "python" || command.runner === "python3") && command.argv.includes("-c")) return false;
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

  async sweep(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.pools.values()].map(async ({ executor }) => {
      await executor.sweep();
      await executor.collectGarbage();
    }));
    if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("Offload pool sweep unverified");
  }

  async shutdown(): Promise<void> {
    // Fence both new and already-awaiting resolutions before taking the pool
    // snapshot. Keep run-state reads available while those pools drain.
    this.closing = true;
    await Promise.all([...this.pools.values()].map(async ({ executor, guest }) => {
      await executor.shutdown();
      await guest.shutdown();
    }));
    this.closed = true;
  }
}
