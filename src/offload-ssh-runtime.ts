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
import { canonicalRepoId, V1_PROFILE } from "./offload/routes.js";
import { classifyCargo } from "./offload/router.js";
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
    if (!binding || Date.now() - binding.seenAt > 24 * 60 * 60_000 || binding.repoId !== command.repoId
      || command.profileId !== V1_PROFILE.id || classifyCargo(command.argv, V1_PROFILE).mode !== "remote_candidate"
      || !this.confined(command)) return null;
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
      workspace: (vm, cmd) => sync.cwd(vm, cmd), ...this.deps.guestOptions });
    // Sync-in begins every reservation, including resumed VMs: discard stale
    // host-key/IP state and authorize via the provider before transferring.
    const executor = new OffloadExecutor({ boat: api, state: this.deps.state, accountId: this.deps.accountId, poolId,
      logger: this.deps.logger, now: Date.now,
      config: { maxOffloadVms: binding.config.maxOffloadVms, offloadIdleStopSeconds: binding.config.offloadIdleStopSeconds,
        size: binding.config.size, maxActive: binding.config.maxActive, maxStartsPerDay: binding.config.maxStartsPerDay,
        minComputeHoursLeft: binding.config.minComputeHoursLeft },
      guest, runCommand: (vm, cmd, context) => guest.runCommand(vm, cmd, context),
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

  private confined(command: BackendCommand): boolean {
    if (path.posix.isAbsolute(command.cwdRelative) || command.cwdRelative.includes("\0") || LONE_SURROGATE.test(command.cwdRelative)
      || command.cwdRelative.split("/").some((part) => part === ".." || part === "")) return false;
    // V1 refuses all path-bearing Cargo overrides rather than guessing which
    // belong to the host or silently rewriting arguments. Relative cwd is enough.
    return !command.argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg) || LONE_SURROGATE.test(arg)
      || /^(--(manifest-path|target-dir|out-dir|artifact-dir|lockfile-path)|-C)(=|$)/.test(arg));
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
