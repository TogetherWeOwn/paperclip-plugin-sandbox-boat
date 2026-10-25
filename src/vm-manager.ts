// The lifecycle of boat VMs for Paperclip runs, built for the lowest cost:
//   - one VM per card (execution workspace, else issue), kept stopped between
//     runs so its checkout and build caches stay on disk (docs.boat.dev
//     platform guide, "Pattern 3: stop and resume around usage");
//   - a VM runs only while a run holds it: release stops it at once (billing
//     stops at the stop), and a sweep stops anything that idles;
//   - auto-stop is boat's deadline safety net, extended only while a command
//     is actually running (docs.boat.dev/long-running-tasks/auto-stop);
//   - every start (create, resume) passes the budget guard first and uses
//     fail-fast, so nothing waits for a machine or a rate window.
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
} from "@paperclipai/plugin-sdk";
import { boatApi, waitReady } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { BoatBudgetError, checkBudget, readBudget } from "./budget.js";
import type { BudgetSnapshot } from "./budget.js";
import { PRICE_PER_HOUR, parseDriverConfig, remoteWorkspaceDirProblem, resolveApiKey, resolveCostApiKey } from "./config.js";
import type { BoatDriverConfig, BoatSize } from "./config.js";
import { parseTaskClass, requireBoatSize, selectSize } from "./size-policy.js";
import { effectiveEnvAllowlist, filterRunEnv, isAcpProcessSessionCommand } from "./env-policy.js";
import type { EnvDrop } from "./env-policy.js";
import { BoatProviderError, describeBoatError, formatBoatError } from "./errors.js";
import type { BoatErrorInfo } from "./errors.js";
import {
  RUNTIME_DIR_RESULT_RE,
  RUNTIME_SECRET_SCRUB_INCOMPLETE_EXIT,
  RUNTIME_SECRET_SCRUB_RESULT_RE,
  SCRUB_BASHRC_ASCII_TOKEN,
  assertValidEnvKeys,
  buildLoginShellScript,
  buildRemoteCommand,
  buildRemoteEnvFileContents,
  newRemoteEnvStage,
  removeRemoteEnvCommand,
  runtimeDirScript,
  scrubRuntimeSecretsScript,
  shellQuote,
  stageRemoteEnvCommand,
} from "./shell.js";
import type { RemoteEnvStage } from "./shell.js";
import { SshManager, endpointFromSshKeyResponse, runProcess } from "./ssh.js";
import type { SshSession } from "./ssh.js";
import { runOutsideInvocation } from "./proactive.js";
import { syncFiles } from "./file-sync.js";
import { VmStateStore, findBySandboxId, mergeRemoteRoot } from "./state.js";
import type { RunSession, StartKind, StateClientLike, StateDoc, UsageReading, VmKeyKind, VmRecord } from "./state.js";
import { NeverDispatchBackend, OffloadBroker, type OffloadJournalStore } from "./offload/broker.js";
import { V1_PROFILE, handleCancel, handleExec, handleHeartbeat, handleRead, type RouteActor } from "./offload/routes.js";

// "init" .. "running" are up (or coming up) and may bill; see docs.boat.dev/readiness.
const UP_STATES = new Set(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running"]);
const EXTEND_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ACTIVITY_PERSIST_INTERVAL_MS = 60 * 1000;
// Below the minimum idle-stop threshold (one minute), including silent syncs.
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 15_000;
const SWEEP_MIN_INTERVAL_MS = 60 * 1000;
const STOP_POLL_INTERVAL_MS = 2000;
// After an accepted stop, release waits at most this long for the VM to leave
// UP before returning: returning stopped while the VM still looks up would
// race the next run (it would reuse the running VM just as boat starts
// archiving it). The snapshot save itself is still confirmed by the sweep.
const STOP_ACCEPT_POLL_MS = 10_000;
const DONE_ISSUE_STATUSES = new Set(["done", "cancelled"]);
// States in which boat accepts SSH (POST /sshkey answers machine_not_running otherwise).
const SSH_STATES = new Set(["ready", "idle", "running"]);
const SCRUB_TIMEOUT_MS = 60_000;

/** What the run-secret scrub before a stop, delete or capture found. */
export interface RuntimeScrubOutcome {
  /**
   * clean: nothing to remove; scrubbed: removed and verified; vm_not_running:
   * nothing to reach; incomplete: nothing left that it could see, but part of
   * the disk could not be searched, so it is not verified; failed: something is
   * left, or the scrub did not run to a result.
   */
  status: "clean" | "scrubbed" | "vm_not_running" | "incomplete" | "failed";
  removed: number;
  detail?: string;
}

/** A scrub that leaves the disk unverified: never good enough for a template, never a reason to keep a VM running. */
function scrubUnverified(scrub: RuntimeScrubOutcome): boolean {
  return scrub.status === "failed" || scrub.status === "incomplete";
}

/** The reason a log gives for an unverified scrub. */
function unverifiedScrubReason(scrub: RuntimeScrubOutcome): string {
  return scrub.status === "incomplete"
    ? `part of its disk could not be searched for the run MCP config (${scrub.detail ?? "unverified"})`
    : `the run MCP config could not be removed from its disk (${scrub.detail ?? "unverified"})`;
}

/**
 * Why a VM whose scrub (or, at a failed start, link) failed is stopped with
 * its disk kept instead of deleted (VmManager.logKeptDisk).
 */
type KeptDiskReason = "stop_lease" | "stop_and_retain" | "held_lease" | "incomplete_scan" | "resumed_disk";

/** A run still holds the VM: an active run, or the open run window of a resumed lease (which never joins activeRunIds). */
function runHoldsVm(record: VmRecord | null | undefined): boolean {
  return !!record && (record.activeRunIds.length > 0 || record.sessions.some((entry) => !entry.endedAt));
}

export interface ManagerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface IssueReader {
  get(issueId: string, companyId: string): Promise<{ status?: string | null } | null>;
}

export interface ExecutionWorkspaceReader {
  get(
    workspaceId: string,
    companyId: string,
  ): Promise<{ repoUrl: string | null; projectId: string; projectWorkspaceId: string | null; path: string | null; cwd: string | null } | null>;
}

export interface ManagerDeps {
  state: StateClientLike;
  logger: ManagerLogger;
  issues?: IssueReader | null;
  executionWorkspaces?: ExecutionWorkspaceReader | null;
  ssh?: SshManager;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SandboxView {
  id: string;
  name: string | null;
  state: string;
  type: string | null;
  archiveAfter: string | null;
  dataExpiredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stopStatus: string | null;
}

interface CachedConfig {
  companyId: string;
  environmentId: string;
  config: BoatDriverConfig;
  seenAt: number;
}

export function resolveVmKey(params: {
  executionWorkspaceId?: string | null;
  issueId?: string | null;
  runId: string;
}): { key: string; kind: VmKeyKind } {
  if (params.executionWorkspaceId) return { key: `ew:${params.executionWorkspaceId}`, kind: "executionWorkspace" };
  if (params.issueId) return { key: `issue:${params.issueId}`, kind: "issue" };
  return { key: `run:${params.runId}`, kind: "run" };
}

/** Deterministic sandbox name: the mapping survives a lost plugin state. */
export function sandboxNameFor(prefix: string, companyId: string, environmentId: string, key: string): string {
  const digest = createHash("sha256").update(`${companyId}\u0000${environmentId}\u0000${key}`).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

function toView(raw: unknown): SandboxView | null {
  if (!raw || typeof raw !== "object") return null;
  const sandbox = raw as Record<string, unknown>;
  if (typeof sandbox.id !== "string") return null;
  const stop = sandbox.stop && typeof sandbox.stop === "object" ? (sandbox.stop as Record<string, unknown>) : null;
  return {
    id: sandbox.id,
    name: typeof sandbox.name === "string" ? sandbox.name : null,
    state: typeof sandbox.state === "string" ? sandbox.state : "unknown",
    type: typeof sandbox.type === "string" ? sandbox.type : null,
    archiveAfter: iso(sandbox.archiveAfter),
    dataExpiredAt: iso(sandbox.dataExpiredAt),
    createdAt: iso(sandbox.createdAt),
    updatedAt: iso(sandbox.updatedAt),
    stopStatus: stop && typeof stop.status === "string" ? stop.status : null,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BoatVmManager {
  private readonly store: VmStateStore;
  private readonly ssh: SshManager;
  private readonly logger: ManagerLogger;
  private readonly issues: IssueReader | null;
  private readonly executionWorkspaces: ExecutionWorkspaceReader | null;
  private readonly offloadState: StateClientLike;
  private readonly offloadBrokers = new Map<string, OffloadBroker>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  private readonly lastPersistedActivity = new Map<string, number>();
  private readonly extendTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly deadlines = new Map<string, number>();
  private readonly hardDeadlines = new Map<string, number>();
  private readonly sandboxCompany = new Map<string, string>();
  private readonly configs = new Map<string, CachedConfig>();
  /** Per VM, the sets of dropped env names already logged, so a run's many commands log each set once. */
  private readonly envDropsLogged = new Map<string, Set<string>>();
  /** Per VM, workspace roots already written to its state record (saves a state write per realize). */
  private readonly knownRoots = new Map<string, Set<string>>();
  private lastSweepAt = 0;
  private sweeping: Promise<SweepReport> | null = null;
  private lastBudget: { snapshot: BudgetSnapshot; at: string } | null = null;

  constructor(deps: ManagerDeps) {
    this.store = new VmStateStore(deps.state);
    this.logger = deps.logger;
    this.issues = deps.issues ?? null;
    this.executionWorkspaces = deps.executionWorkspaces ?? null;
    this.offloadState = deps.state;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ssh = deps.ssh ?? new SshManager(deps.logger, this.sleep);
  }

  // ---------------------------------------------------------------- offload

  private offloadStore(companyId: string): OffloadJournalStore {
    const state = this.offloadState;
    const scope = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload", stateKey });
    return {
      get: async (key) => state.get(scope(key)),
      set: async (key, value) => {
        await state.set(scope(key), value);
      },
      delete: async (key) => {
        await state.delete(scope(key));
      },
    };
  }

  private offloadBroker(companyId: string): OffloadBroker {
    let broker = this.offloadBrokers.get(companyId);
    if (!broker) {
      // Until the executor follow-up grows start/cancel, every submit journals
      // not_started and the shim falls back locally: safe by construction.
      broker = new OffloadBroker({ store: this.offloadStore(companyId), backend: new NeverDispatchBackend(), now: this.now });
      this.offloadBrokers.set(companyId, broker);
    }
    return broker;
  }

  private offloadRouteHost(companyId: string) {
    const workspaces = this.executionWorkspaces;
    return {
      broker: this.offloadBroker(companyId),
      workspaces: {
        get: async (workspaceId: string, company: string) => (workspaces ? workspaces.get(workspaceId, company) : null),
      },
      profile: V1_PROFILE,
    };
  }

  async offloadExec(companyId: string, actor: RouteActor, body: unknown): Promise<{ status: number; body: unknown }> {
    return handleExec({ actor, companyId, body }, this.offloadRouteHost(companyId));
  }

  async offloadRead(
    companyId: string,
    actor: RouteActor,
    params: { commandId?: string },
    query: Record<string, string | string[]>,
  ): Promise<{ status: number; body: unknown }> {
    return handleRead({ actor, companyId, params, query }, this.offloadRouteHost(companyId));
  }

  async offloadHeartbeat(companyId: string, actor: RouteActor, params: { commandId?: string }): Promise<{ status: number; body: unknown }> {
    return handleHeartbeat({ actor, companyId, params }, this.offloadRouteHost(companyId));
  }

  async offloadCancel(
    companyId: string,
    actor: RouteActor,
    params: { commandId?: string },
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return handleCancel({ actor, companyId, params, body }, this.offloadRouteHost(companyId));
  }

  // ---------------------------------------------------------------- helpers

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  // Lock order: the card lock first, then `name:<sandbox name>`, then
  // `sandbox:<id>`. Acquire, resume lease, release, destroy, capture and the
  // sweep's stop and delete of a VM it has a record of all hold the card lock,
  // so a new run on a card never reads the VM as running while the previous
  // run's release stops it, and the sweep never stops or deletes a VM that a
  // run is taking. The sweep has no card for an orphan (a VM of ours with no
  // record), which a run whose state was lost finds by its deterministic name:
  // acquire and resume lease also hold the name lock, and the sweep takes it
  // for an orphan.
  private cardLockKey(companyId: string, vmKey: string): string {
    return `card:${companyId}:${vmKey}`;
  }

  private nameLockKey(sandboxName: string): string {
    return `name:${sandboxName}`;
  }

  /** The card lock (when the card is known), then the name lock (when the name is known), around fn. */
  private withVmLocks<T>(companyId: string, vmKey: string | null, sandboxName: string | null, fn: () => Promise<T>): Promise<T> {
    const named = sandboxName ? () => this.withLock(this.nameLockKey(sandboxName), fn) : fn;
    return vmKey ? this.withLock(this.cardLockKey(companyId, vmKey), named) : named();
  }

  /** The card key of a sandbox: from the lease metadata, else from plugin state. */
  private async vmKeyFor(companyId: string, sandboxId: string, leaseMetadata?: Record<string, unknown> | null): Promise<string | null> {
    const fromLease = str(leaseMetadata?.vmKey);
    if (fromLease) return fromLease;
    const doc = await this.store.read(companyId).catch(() => null);
    const record = doc ? findBySandboxId(doc, sandboxId) : null;
    return record ? record.key.split("~")[0] : null;
  }

  private async withCardLock<T>(
    companyId: string,
    sandboxId: string,
    leaseMetadata: Record<string, unknown> | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const vmKey = await this.vmKeyFor(companyId, sandboxId, leaseMetadata);
    return vmKey ? await this.withLock(this.cardLockKey(companyId, vmKey), fn) : await fn();
  }

  private opsApi(config: BoatDriverConfig): BoatApiLike {
    return boatApi({ apiKey: resolveApiKey(config), apiBase: config.apiBase });
  }

  private costApi(config: BoatDriverConfig): BoatApiLike {
    return boatApi({ apiKey: resolveCostApiKey(config), apiBase: config.apiBase });
  }

  /** Keep the latest resolved config per environment in memory for the sweeper. Never persisted. */
  rememberConfig(companyId: string, environmentId: string, config: BoatDriverConfig): void {
    this.configs.set(environmentId, { companyId, environmentId, config, seenAt: this.now() });
  }

  private ttlSeconds(config: BoatDriverConfig, hardDeadlineMs: number | null): number {
    let ttl = config.autoStopMinutes * 60;
    if (hardDeadlineMs != null) {
      const left = Math.floor((hardDeadlineMs - this.now()) / 1000);
      ttl = Math.min(ttl, left);
      if (ttl < 60) {
        throw new BoatProviderError(
          "BOAT_DEADLINE_TOO_SOON",
          "the requested lease deadline is less than a minute away; a boat VM cannot be bounded that tightly. Nothing was started.",
        );
      }
    }
    return ttl;
  }

  private async getSandbox(api: BoatApiLike, sandboxId: string): Promise<SandboxView | null> {
    try {
      const response = await api.get({ sandboxId });
      return toView((response as { sandbox?: unknown }).sandbox);
    } catch (error) {
      const info = await describeBoatError(error);
      if (info.status === 404) return null;
      throw new BoatProviderError("BOAT_API_ERROR", `boat GET sandbox ${sandboxId} failed: ${formatBoatError(info)}`);
    }
  }

  private async listSandboxes(api: BoatApiLike): Promise<SandboxView[]> {
    const views: SandboxView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response = (await api.sandboxes({ limit: 200, ...(cursor ? { cursor } : {}) })) as {
        sandboxes?: unknown[];
        pageInfo?: { hasMore?: boolean; nextCursor?: string | null };
      };
      for (const raw of response.sandboxes ?? []) {
        const view = toView(raw);
        if (view) views.push(view);
      }
      if (!response.pageInfo?.hasMore || !response.pageInfo.nextCursor) break;
      cursor = response.pageInfo.nextCursor;
    }
    return views;
  }

  private async findSandboxByName(api: BoatApiLike, name: string): Promise<SandboxView | null> {
    const all = await this.listSandboxes(api);
    const matches = all.filter((sandbox) => sandbox.name === name && !sandbox.dataExpiredAt && sandbox.state !== "cancelled");
    if (matches.length === 0) return null;
    // Prefer one that is already up (no start needed), then the newest.
    matches.sort((a, b) => {
      const upA = UP_STATES.has(a.state) ? 1 : 0;
      const upB = UP_STATES.has(b.state) ? 1 : 0;
      if (upA !== upB) return upB - upA;
      return Date.parse(b.updatedAt ?? b.createdAt ?? "0") - Date.parse(a.updatedAt ?? a.createdAt ?? "0");
    });
    return matches[0];
  }

  // ------------------------------------------------------------ budget guard

  async readBudget(config: BoatDriverConfig): Promise<BudgetSnapshot> {
    const api = this.opsApi(config);
    let lastError: BoatErrorInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const snapshot = readBudget(await api.limits({}));
        this.lastBudget = { snapshot, at: this.nowIso() };
        return snapshot;
      } catch (error) {
        lastError = await describeBoatError(error);
        if (lastError.status != null && lastError.status < 500 && lastError.status !== 429) break;
        await this.sleep(1000 * (attempt + 1));
      }
    }
    throw new BoatProviderError(
      "BOAT_LIMITS_UNAVAILABLE",
      `could not read boat limits (GET /limits) to check the budget, so no VM was started: ${lastError ? formatBoatError(lastError) : "unknown error"}.`,
    );
  }

  private async guardBudget(config: BoatDriverConfig, context: Record<string, unknown>): Promise<void> {
    const snapshot = await this.readBudget(config);
    const refusal = checkBudget(snapshot, config, config.size);
    if (refusal) {
      this.logger.warn(`boat budget guard refused a VM start: limit=${refusal.limit}`, {
        limit: refusal.limit,
        ...refusal.details,
        ...context,
      });
      throw new BoatBudgetError(refusal);
    }
  }

  private mapStartError(op: string, info: BoatErrorInfo, config: BoatDriverConfig): BoatProviderError {
    const nothing = "Nothing was started or billed.";
    const code = info.code ?? "";
    if (info.status === 429 && code === "rate_limited") {
      return new BoatProviderError(
        "BOAT_START_RATE_LIMITED",
        `boat refused the ${op}: start limit for the last ${info.window ?? "window"} is used up${info.limit != null ? ` (${info.limit})` : ""}. ${nothing}`,
        { window: info.window, limit: info.limit },
      );
    }
    if (info.status === 429 && (code === "limit_reached" || code === "member_limit_reached")) {
      return new BoatProviderError("BOAT_ACTIVE_LIMIT", `boat refused the ${op}: the plan's sandboxes-at-once limit is full. ${nothing}`);
    }
    if (info.status === 429 && code === "trial_compute_limit_reached") {
      return new BoatProviderError("BOAT_TRIAL_COMPUTE_USED", `boat refused the ${op}: the trial's 25 hours of compute are used. ${nothing}`);
    }
    if (info.status === 402) {
      return new BoatProviderError("BOAT_BILLING_REQUIRED", `boat refused the ${op}: the balance is empty or there is no plan (${code || "billing_required"}). ${nothing}`);
    }
    if (info.status === 403 && (code === "trial_machine_class_not_allowed" || code === "machine_class_plan_required")) {
      return new BoatProviderError("BOAT_SIZE_NOT_ALLOWED", `boat refused the ${op}: size ${config.size} is not allowed on this plan. ${nothing}`);
    }
    if (info.status === 400 && code === "trial_auto_stop_required") {
      return new BoatProviderError(
        "BOAT_AUTO_STOP_TOO_LONG",
        `boat refused the ${op}: the trial needs auto-stop of 2 hours or less (config autoStopMinutes=${config.autoStopMinutes}). ${nothing}`,
      );
    }
    if (info.status === 503 && code === "no_ready_machine") {
      return new BoatProviderError(
        "BOAT_NO_READY_MACHINE",
        `no boat machine of size ${config.size} is ready right now (fail-fast). ${nothing} Retry in a minute, or run this card on the local environment.`,
      );
    }
    if (info.status === 503 && code === "out_of_capacity") {
      return new BoatProviderError("BOAT_OUT_OF_CAPACITY", `boat is out of machines for a short time. ${nothing} Retry in about 2 minutes.`);
    }
    if (info.status === 409 && code === "monitoring_off_for_account") {
      return new BoatProviderError(
        "BOAT_MONITORING_OFF_FOR_ACCOUNT",
        `boat refused the ${op}: the account disables monitoring. Set monitoring=false for new VMs or ask the account administrator to review that policy. The plugin will not change account settings or retry with a different monitoring policy. ${nothing}`,
      );
    }
    if (info.status === 409 && code === "snapshot_data_expired") {
      return new BoatProviderError("BOAT_SNAPSHOT_EXPIRED", "the stopped VM's disk is older than 14 days and boat deleted it.");
    }
    if (info.status === 404 && code === "snapshot_not_found") {
      return new BoatProviderError(
        "BOAT_TEMPLATE_NOT_FOUND",
        `the named snapshot "${config.templateSnapshot}" does not exist (config templateSnapshot). ${nothing}`,
      );
    }
    return new BoatProviderError("BOAT_START_FAILED", `boat ${op} failed: ${formatBoatError(info)}`);
  }

  /** One start call with boat's documented retry rules (docs.boat.dev/limits#retry-rules). */
  private async startCall<T>(
    op: "create" | "resume",
    config: BoatDriverConfig,
    call: () => Promise<T>,
    settled?: () => Promise<boolean>,
  ): Promise<T | null> {
    let noMachine = 0;
    let transient = 0;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        const info = await describeBoatError(error);
        if (info.status === 503 && info.code === "no_ready_machine" && noMachine < config.noReadyMachineRetries) {
          // Nothing started, billed or counted; a short wait often finds a machine.
          noMachine += 1;
          await this.sleep(Math.min(10, info.retryAfterSeconds ?? 5) * 1000);
          continue;
        }
        if (info.status === 409 && info.code === "idempotency_in_progress" && transient < 5) {
          transient += 1;
          await this.sleep(2000);
          continue;
        }
        if (op === "resume" && info.status === 409 && (info.code === "sandbox_resuming" || info.code === "sandbox_securing")) {
          return null;
        }
        const ambiguous = info.status == null || (info.status >= 500 && info.code !== "no_ready_machine" && info.code !== "out_of_capacity");
        if (ambiguous && transient < 2) {
          if (settled && (await settled().catch(() => false))) return null;
          transient += 1;
          await this.sleep(1500 * transient);
          continue;
        }
        throw this.mapStartError(op, info, config);
      }
    }
  }

  // ------------------------------------------------------------- SSH setup

  private async openSsh(api: BoatApiLike, config: BoatDriverConfig, sandboxId: string): Promise<SshSession> {
    const key = await this.ssh.ensureKey();
    const deadline = this.now() + config.timeoutMs;
    let response: Awaited<ReturnType<BoatApiLike["sshKey"]>> | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await api.sshKey({ sandboxId, key: key.publicKey });
        break;
      } catch (error) {
        const info = await describeBoatError(error);
        const retryable =
          info.status === 503 ||
          info.status === 502 ||
          (info.status === 409 && ["sandbox_starting", "sandbox_securing", "sandbox_restoring", "sandbox_resuming"].includes(info.code ?? "")) ||
          (info.status === 400 && info.code === "machine_not_running");
        if (!retryable || attempt >= 15 || this.now() > deadline) {
          throw new BoatProviderError("BOAT_SSH_KEY_FAILED", `could not authorize SSH on boat VM ${sandboxId}: ${formatBoatError(info)}`);
        }
        await this.sleep(2000);
      }
    }
    const endpoint = endpointFromSshKeyResponse(response);
    const session = await this.ssh.openSession({
      sandboxId,
      endpoint,
      tunnel: config.cliproxyTunnel
        ? { remotePort: config.tunnelRemotePort, targetHost: config.tunnelTargetHost, targetPort: config.tunnelTargetPort }
        : null,
      connectTimeoutSec: config.sshConnectTimeoutSec,
    });
    return session;
  }

  /** First command on a fresh session: proves SSH works, makes the workspace dir, reads home and shell. */
  private async prepareRemote(
    config: BoatDriverConfig,
    session: SshSession,
  ): Promise<{ remoteCwd: string; shellCommand: "bash" | "sh" }> {
    const dirExpr = config.remoteWorkspaceDir ? shellQuote(config.remoteWorkspaceDir) : '"$HOME/paperclip-workspace"';
    // Also removes boat's ASCII_TOKEN line from ~/.bashrc (shell.ts), so no shell the agent starts exports it.
    const script = `${SCRUB_BASHRC_ASCII_TOKEN}; d=${dirExpr}; mkdir -p "$d" && if command -v bash >/dev/null 2>&1; then s=bash; else s=sh; fi; printf '%s\\n%s\\n' "$d" "$s"`;
    const deadline = this.now() + config.timeoutMs;
    let last = "";
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.ssh.run(session, `sh -c ${shellQuote(script)}`, { timeoutMs: 60_000 });
      if (!result.timedOut && result.exitCode === 0) {
        const [dir, shell] = result.stdout.split(/\r?\n/);
        await this.ssh.ensureMaster(session);
        return { remoteCwd: dir?.trim() || "/home/user/paperclip-workspace", shellCommand: shell?.trim() === "bash" ? "bash" : "sh" };
      }
      last = (result.stderr || result.stdout).trim();
      // In the first seconds after a start, SSH can answer sandbox_restoring /
      // sandbox_securing (docs.boat.dev/ssh-access). Retry a few seconds later.
      if (result.exitCode !== 255 || attempt >= 10 || this.now() > deadline) break;
      await this.sleep(3000);
    }
    throw new BoatProviderError("BOAT_SSH_FAILED", `SSH to boat VM ${session.sandboxId} failed: ${last.slice(0, 500) || "unknown error"}`);
  }

  // ------------------------------------------------- run secrets on the VM

  /** Remember a workspace root of a VM in its state record, so a later scrub (also the sweep's, in another worker) looks there. */
  private async rememberRemoteRoot(companyId: string, sandboxId: string, root: string | null): Promise<void> {
    if (!root) return;
    const known = this.knownRoots.get(sandboxId) ?? new Set<string>();
    if (known.has(root)) return;
    await this.store
      .update(companyId, (doc) => {
        const record = findBySandboxId(doc, sandboxId);
        if (record) record.remoteRoots = mergeRemoteRoot(record.remoteRoots, root);
      })
      .then(() => {
        known.add(root);
        this.knownRoots.set(sandboxId, known);
      })
      .catch((error) => this.logger.warn("boat: could not record the VM workspace root", { sandboxId, error: errorText(error) }));
  }

  /** Every workspace root Paperclip may have put `.paperclip-runtime/` under on this VM. */
  private runtimeRoots(
    config: BoatDriverConfig,
    sandboxId: string,
    leaseMetadata: Record<string, unknown> | null | undefined,
    record: VmRecord | null,
  ): string[] {
    return [
      ...(record?.remoteRoots ?? []),
      str(leaseMetadata?.remoteCwd),
      config.remoteWorkspaceDir,
      ...(this.knownRoots.get(sandboxId) ?? []),
    ].filter((root): root is string => typeof root === "string" && root.length > 0);
  }

  /**
   * Delete the run credentials Paperclip writes into the VM as files: the
   * `mcp-config` runtime asset under `<root>/.paperclip-runtime/<adapter>/`,
   * whose MCP headers carry the run JWT (shell.ts, scrubRuntimeSecretsScript).
   * boat saves /home/user in every stop snapshot and named snapshot, so this
   * runs before every stop, delete and capture the plugin makes. It uses the
   * VM's SSH session, or opens one when the VM runs and this worker has none
   * (`connect`). Never throws.
   */
  private async scrubRuntimeSecrets(input: {
    api: BoatApiLike;
    config: BoatDriverConfig;
    sandboxId: string;
    roots: readonly string[];
    before: "stop" | "delete" | "template capture";
    connect: boolean;
    session?: SshSession | null;
  }): Promise<RuntimeScrubOutcome> {
    const { sandboxId } = input;
    let session = input.session ?? this.ssh.getSession(sandboxId);
    if (!session) {
      if (!input.connect) return this.reportScrub(input, { status: "vm_not_running", removed: 0, detail: "no SSH session" });
      const sandbox = await this.getSandbox(input.api, sandboxId).catch(() => undefined);
      if (sandbox === null || (sandbox && !SSH_STATES.has(sandbox.state))) {
        return this.reportScrub(input, { status: "vm_not_running", removed: 0, detail: sandbox ? `state ${sandbox.state}` : "VM gone" });
      }
      try {
        session = await this.openSsh(input.api, input.config, sandboxId);
      } catch {
        return this.reportScrub(input, { status: "failed", removed: 0, detail: "SSH connection failed (diagnostics withheld)" });
      }
    }
    let result: Awaited<ReturnType<SshManager["run"]>>;
    try {
      result = await this.ssh.run(session, `sh -c ${shellQuote(scrubRuntimeSecretsScript(input.roots))}`, { timeoutMs: SCRUB_TIMEOUT_MS });
    } catch {
      return this.reportScrub(input, { status: "failed", removed: 0, detail: "scrub command failed (diagnostics withheld)" });
    }
    const counts = RUNTIME_SECRET_SCRUB_RESULT_RE.exec(result.stdout);
    if (!result.timedOut && counts && counts[2] === "0") {
      const removed = Number(counts[1]);
      if (result.exitCode === 0 && counts[3] === "complete") {
        return this.reportScrub(input, { status: removed > 0 ? "scrubbed" : "clean", removed });
      }
      if (result.exitCode === RUNTIME_SECRET_SCRUB_INCOMPLETE_EXIT && counts[3] === "incomplete") {
        // Nothing left that it could see, but a directory it had to search was unreadable: not verified.
        return this.reportScrub(input, { status: "incomplete", removed, detail: "walk incomplete (diagnostics withheld)" });
      }
    }
    if (result.exitCode === 255) {
      const sandbox = await this.getSandbox(input.api, sandboxId).catch(() => undefined);
      if (sandbox === null || (sandbox && !UP_STATES.has(sandbox.state))) {
        return this.reportScrub(input, { status: "vm_not_running", removed: 0, detail: sandbox ? `state ${sandbox.state}` : "VM gone" });
      }
    }
    const detail = result.timedOut
      ? `timed out after ${SCRUB_TIMEOUT_MS / 1000} s`
      : `exit ${result.exitCode}${counts ? `, ${counts[2]} left` : ""} (diagnostics withheld)`;
    return this.reportScrub(input, { status: "failed", removed: counts ? Number(counts[1]) : 0, detail });
  }

  private reportScrub(input: { sandboxId: string; before: string }, outcome: RuntimeScrubOutcome): RuntimeScrubOutcome {
    const meta = { sandboxId: input.sandboxId, before: input.before, removed: outcome.removed, ...(outcome.detail ? { detail: outcome.detail } : {}) };
    if (outcome.status === "scrubbed") {
      this.logger.info(`boat: removed Paperclip's run MCP config (it holds the run JWT) from the VM before the ${input.before}`, meta);
    } else if (outcome.status === "failed") {
      this.logger.error(
        `boat: could not remove Paperclip's run MCP config (it holds the run JWT, valid up to 48 h) from the VM before the ${input.before}; the VM disk may keep it`,
        meta,
      );
    } else if (outcome.status === "incomplete") {
      this.logger.error(
        `boat: could not verify that Paperclip's run MCP config (it holds the run JWT, valid up to 48 h) is gone from the VM before the ${input.before}: part of its disk could not be searched`,
        meta,
      );
    } else if (outcome.status === "vm_not_running" && input.before !== "delete") {
      this.logger.warn(
        `boat: could not reach the VM to remove Paperclip's run MCP config before the ${input.before}; if boat stopped it (auto-stop), its disk may keep the run JWT until a later release removes it`,
        meta,
      );
    }
    return outcome;
  }

  /**
   * Make `<root>/.paperclip-runtime` a real 0700 directory, or keep one, and
   * put `.paperclip-runtime/` into `~/.boatignore` (shell.ts,
   * runtimeDirScript), so the run MCP config with the run JWT, and the other
   * files Paperclip syncs there for each run, stay out of the per-minute and
   * stop snapshots. Runs before Paperclip syncs anything: at acquire, at a
   * resumed lease and at realize. Returns the directory; throws
   * BOAT_RUNTIME_DIR_FAILED.
   */
  private async prepareRuntimeDir(session: SshSession, root: string): Promise<string> {
    // onVm: the script ran on the VM and failed there (not ssh's 255 or a timeout), so the disk is in a state it cannot fix.
    const fail = (detail: string, onVm: boolean) =>
      new BoatProviderError(
        "BOAT_RUNTIME_DIR_FAILED",
        `could not create ${root} with its .paperclip-runtime left out of boat's snapshots (~/.boatignore) on boat VM ${session.sandboxId}, so Paperclip's run MCP config (run JWT) would land in them: ${detail}`,
        { onVm },
      );
    let result: Awaited<ReturnType<SshManager["run"]>>;
    try {
      result = await this.ssh.run(session, `sh -c ${shellQuote(runtimeDirScript(root))}`, { timeoutMs: 60_000 });
    } catch (error) {
      throw fail(errorText(error).slice(0, 300), false);
    }
    const line = RUNTIME_DIR_RESULT_RE.exec(result.stdout);
    const expected = `${root.trim().replace(/\/+$/, "")}/.paperclip-runtime`;
    if (result.timedOut || result.exitCode !== 0 || !line || line[2] !== expected) {
      const onVm = !result.timedOut && result.exitCode != null && result.exitCode !== 255;
      throw fail(result.timedOut ? "timed out" : `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, onVm);
    }
    if (line[1] === "made") {
      this.logger.info("boat: made Paperclip's runtime directory on the VM, left out of boat's snapshots by ~/.boatignore", {
        sandboxId: session.sandboxId,
        root,
        runtimeDir: line[2],
      });
    }
    return line[2];
  }

  /**
   * After a resume for a command (auto-stop or the sweep stopped the VM
   * mid-lease): prepare every known root again, so the `.boatignore` rule and
   * the directory are in place before Paperclip's next sync into
   * `.paperclip-runtime` (the sync-back at the run's end). Best effort: logs a
   * warning.
   */
  private async reprepareRuntimeDirs(config: BoatDriverConfig, companyId: string, sandboxId: string, session: SshSession): Promise<void> {
    const record = await this.store
      .read(companyId)
      .then((doc) => findBySandboxId(doc, sandboxId))
      .catch(() => null);
    const roots = new Set(this.runtimeRoots(config, sandboxId, null, record).map((root) => root.trim().replace(/\/+$/, "")));
    for (const root of roots) {
      if (!root.startsWith("/") || root.length < 2) continue;
      try {
        await this.prepareRuntimeDir(session, root);
      } catch (error) {
        this.logger.warn("boat: could not prepare Paperclip's runtime directory again after a resume", { sandboxId, root, error: errorText(error) });
      }
    }
  }

  /**
   * A scrub that failed means the VM disk may still hold the run JWT, and a
   * stop would save it in the stop snapshot (kept 14 days). So the VM is
   * deleted instead: boat erases its disk and its snapshots, and the card's
   * next run starts a fresh VM (from templateSnapshot when set), which costs one
   * start. Returns false when the delete fails; the caller then stops the VM,
   * because a running VM bills and keeps the token live. Never called where
   * the disk must be kept (logKeptDisk).
   */
  private async deleteInsteadOfStop(input: {
    api: BoatApiLike;
    config: BoatDriverConfig;
    companyId: string;
    sandboxId: string;
    runId: string | null;
    trigger: "release" | "stop lease" | "sweep" | "failed start";
    reason: string;
  }): Promise<boolean> {
    const meta = { sandboxId: input.sandboxId, trigger: input.trigger, reason: input.reason };
    this.logger.warn(
      `boat: deleting the VM instead of stopping it (${input.trigger}): ${input.reason}; a stop would keep its disk, run JWT included, in boat's stop snapshot for 14 days. The card's next run starts a fresh VM.`,
      meta,
    );
    await this.recordStopUsage(input.config, input.companyId, input.sandboxId, input.runId).catch(() => undefined);
    try {
      await this.deleteSandbox(input.api, input.sandboxId);
    } catch (error) {
      this.logger.error("boat: could not delete the VM whose disk may keep the run JWT; stopping it instead", { ...meta, error: errorText(error) });
      return false;
    }
    await this.markDeleted(input.companyId, input.sandboxId).catch((error) =>
      this.logger.warn("boat: could not forget the deleted VM in plugin state", { sandboxId: input.sandboxId, error: errorText(error) }),
    );
    return true;
  }

  /**
   * The scrub failed, but the VM's disk holds work that Paperclip still needs,
   * so the VM is stopped and its disk kept (never deleted):
   * * `stop_lease` / `stop_and_retain`: Paperclip asked to keep the disk. It does
   *   that to keep a run's unexported work (a failed run, a failed native
   *   finalize), and its export-resume recovery needs a `stopped` receipt. The
   *   SDK forbids a delete as the fallback of a stop-and-retain. The scrub is
   *   most likely to fail exactly then: a wedged or out-of-memory VM.
   * * `held_lease`: a run still holds the VM (an active run, or the open run
   *   window of a resumed lease), so its work is not synced back yet.
   * * `incomplete_scan`: the scrub found nothing left, but could not search
   *   part of the disk (a directory the SSH user cannot read). That is not
   *   verified, so no template is captured from it, but it is no evidence of a
   *   left-over run JWT either: a delete would destroy the card's work on a guess.
   * * `resumed_disk`: a failed start of the card's resumed VM (TOG-37714). Its
   *   disk holds the card's checkout and caches, and possibly the unexported
   *   work of a run that failed; a freshly created VM holds nothing yet and is
   *   deleted instead.
   * On a VM set up by this version, `~/.boatignore` leaves `.paperclip-runtime`
   * out of every snapshot (shell.ts, runtimeDirScript), so the stop snapshot
   * does not get the MCP config. A VM whose `~/.boatignore` lost the rule (the
   * agent can edit it) may keep the run JWT there. The owner accepted that
   * residual risk.
   */
  private logKeptDisk(input: { sandboxId: string; trigger: "release" | "stop lease" | "sweep" | "failed start"; keep: KeptDiskReason; reason: string }): void {
    const why = {
      stop_lease: "Paperclip's StopLease must keep the disk",
      stop_and_retain: "Paperclip asked to keep the disk (stop_and_retain)",
      held_lease: "a run still holds the VM",
      incomplete_scan: "nothing left was found, and a delete on an unverified scan would destroy the card's work",
      resumed_disk: "it is the card's resumed VM, whose disk holds the card's work",
    }[input.keep];
    this.logger.error(
      `boat: stopping the VM and keeping its disk although ${input.reason} (${input.trigger}): ${why}, and the disk may hold a run's unexported work. ~/.boatignore leaves .paperclip-runtime out of boat's snapshots; a VM whose ~/.boatignore lost that rule may keep the run JWT (valid up to 48 h) in the stop snapshot.`,
      { sandboxId: input.sandboxId, trigger: input.trigger, keep: input.keep, reason: input.reason },
    );
  }

  // ---------------------------------------------------------- deadline/extend

  private noteDeadline(sandboxId: string, archiveAfter: string | null): void {
    if (archiveAfter) this.deadlines.set(sandboxId, Date.parse(archiveAfter));
  }

  /**
   * Auto-stop counts from the start or the last resume, not from activity, so a
   * long run must move it forward. PATCH ttlSeconds sets the deadline to now +
   * TTL (`boat extend`). Only called while a command runs, so an idle VM is never
   * kept alive by this.
   */
  async maybeExtend(config: BoatDriverConfig, sandboxId: string): Promise<void> {
    const ttlMs = config.autoStopMinutes * 60 * 1000;
    const known = this.deadlines.get(sandboxId);
    if (known != null && known - this.now() > ttlMs / 2) return;
    const hard = this.hardDeadlines.get(sandboxId) ?? null;
    let ttlSeconds = config.autoStopMinutes * 60;
    if (hard != null) ttlSeconds = Math.min(ttlSeconds, Math.floor((hard - this.now()) / 1000));
    if (ttlSeconds < 60) return;
    try {
      const response = await this.opsApi(config).update({ sandboxId, ttlSeconds });
      const view = toView((response as { sandbox?: unknown }).sandbox);
      this.deadlines.set(sandboxId, view?.archiveAfter ? Date.parse(view.archiveAfter) : this.now() + ttlSeconds * 1000);
      this.logger.info("boat: extended auto-stop deadline while a command runs", { sandboxId, ttlSeconds });
    } catch (error) {
      this.logger.warn("boat: could not extend the auto-stop deadline", { sandboxId, error: errorText(error) });
    }
  }

  private async beginActivity(config: BoatDriverConfig, companyId: string, sandboxId: string): Promise<void> {
    // Publish before admitting work. A failed write must not launch a command
    // that another manager cannot see. Heartbeats expire naturally after a
    // worker dies; do not persist a permanent busy bit.
    await this.store.touchActivity(companyId, sandboxId, this.now());
    this.inflight.set(sandboxId, (this.inflight.get(sandboxId) ?? 0) + 1);
    this.lastActivity.set(sandboxId, this.now());
    if (!this.heartbeatTimers.has(sandboxId)) {
      const timer = setInterval(() => {
        void runOutsideInvocation(() => this.store.touchActivity(companyId, sandboxId, this.now()))
          .catch(() => this.logger.warn("boat: could not persist command activity heartbeat", { sandboxId }));
      }, ACTIVITY_HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
      this.heartbeatTimers.set(sandboxId, timer);
    }
    if (!this.extendTimers.has(sandboxId)) {
      const timer = setInterval(() => {
        void this.maybeExtend(config, sandboxId);
      }, EXTEND_CHECK_INTERVAL_MS);
      timer.unref?.();
      this.extendTimers.set(sandboxId, timer);
    }
  }

  private async endActivity(companyId: string, sandboxId: string): Promise<void> {
    const left = Math.max(0, (this.inflight.get(sandboxId) ?? 1) - 1);
    if (left === 0) {
      this.inflight.delete(sandboxId);
      this.clearExtendTimer(sandboxId);
    } else {
      this.inflight.set(sandboxId, left);
    }
    const now = this.now();
    this.lastActivity.set(sandboxId, now);
    // Always publish completion, even for short commands; do not clear a
    // shared heartbeat while a command in another manager may still run.
    await this.store.touchActivity(companyId, sandboxId, now)
      .catch(() => this.logger.warn("boat: could not persist command completion activity", { sandboxId }));
    const persisted = this.lastPersistedActivity.get(sandboxId) ?? 0;
    if (now - persisted >= ACTIVITY_PERSIST_INTERVAL_MS) {
      this.lastPersistedActivity.set(sandboxId, now);
      await this.store
        .update(companyId, (doc) => {
          const record = findBySandboxId(doc, sandboxId);
          if (record) record.lastActivityAt = new Date(now).toISOString();
        })
        .catch(() => undefined);
    }
  }

  private clearExtendTimer(sandboxId: string): void {
    const heartbeat = this.heartbeatTimers.get(sandboxId);
    if (heartbeat) clearInterval(heartbeat);
    this.heartbeatTimers.delete(sandboxId);
    const timer = this.extendTimers.get(sandboxId);
    if (timer) clearInterval(timer);
    this.extendTimers.delete(sandboxId);
  }

  private warnUnmeasuredSmall(choice: ReturnType<typeof selectSize>): void {
    if (choice.source === "fallback" && choice.size === "small") {
      this.logger.warn(
        "boat: unmeasured task class falls back to small; use size=default for heavy builds (small failed the Rust benchmark), or supply successful sizeCostTable measurements",
        { taskClass: choice.taskClass, size: choice.size },
      );
    }
  }

  // --------------------------------------------------------------- lifecycle

  async acquire(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const taskClass = parseTaskClass(params.executionWorkspaceSettings?.boatTaskClass, config.taskClass);
    // A config saved before this check: such a root fails at the runtime directory on every VM, so refuse it before boat spends a start.
    const workspaceProblem = remoteWorkspaceDirProblem(config.remoteWorkspaceDir);
    if (workspaceProblem) throw new BoatProviderError("BOAT_CONFIG_INVALID", workspaceProblem);
    this.rememberConfig(params.companyId, params.environmentId, config);
    const { key, kind } = resolveVmKey(params);
    const name = sandboxNameFor(config.namePrefix, params.companyId, params.environmentId, key);
    const hardDeadlineMs = params.requestedExpiresAt ? Date.parse(params.requestedExpiresAt) : null;
    const ttlSeconds = this.ttlSeconds(config, Number.isNaN(hardDeadlineMs ?? 0) ? null : hardDeadlineMs);
    const api = this.opsApi(config);
    await this.store.rememberCompany(params.companyId);

    return await this.withVmLocks(params.companyId, key, name, async () => {
      const doc = await this.store.read(params.companyId);
      const existing = doc.vms[key] && doc.vms[key].status !== "deleted" ? doc.vms[key] : null;
      let sandbox = existing ? await this.getSandbox(api, existing.sandboxId) : null;
      if (!sandbox && kind !== "run") sandbox = await this.findSandboxByName(api, name);
      if (sandbox?.state === "archiving") {
        // A stop (auto-stop, the sweep, or a stop from another worker) is still
        // saving the disk. boat refuses a resume until it ends, so wait for it.
        sandbox = await this.waitUntilStopped(api, sandbox, config.stopConfirmTimeoutMs);
      }
      if (sandbox && (sandbox.dataExpiredAt || sandbox.state === "cancelled")) sandbox = null;

      const runningSize = sandbox && sandbox.state !== "archived" ? requireBoatSize(sandbox.type) : undefined;
      const sizeChoice = selectSize(config, taskClass, runningSize);
      config.size = sizeChoice.size;
      const context = { vmKey: key, runId: params.runId, issueId: params.issueId ?? null };
      this.logger.info("boat: size choice for lease", { ...context, ...sizeChoice });
      this.warnUnmeasuredSmall(sizeChoice);
      let sandboxId = "";
      let startKind: StartKind;
      let startedNew = false;
      // The card's existing VM was resumed: its disk holds the card's work (TOG-37714).
      let resumedExisting = false;
      let archiveAfter: string | null = null;
      try {
        if (sandbox && UP_STATES.has(sandbox.state)) {
          sandboxId = sandbox.id;
          startKind = "reuse_running";
          archiveAfter = sandbox.archiveAfter;
        } else {
          let resumed = false;
          if (sandbox) {
            await this.guardBudget(config, context);
            const target = sandbox;
            const sizeChange = target.state === "archived" && target.type !== config.size ? { type: config.size } : {};
            try {
              const response = await this.startCall(
                "resume",
                config,
                () => api.resume({ sandboxId: target.id, failFast: config.failFast, ttlSeconds, ...sizeChange }),
                async () => {
                  const now = await this.getSandbox(api, target.id);
                  return !!now && UP_STATES.has(now.state);
                },
              );
              sandboxId = target.id;
              startKind = "resume";
              startedNew = true;
              resumed = true;
              resumedExisting = true;
              archiveAfter = toView((response as { sandbox?: unknown } | null)?.sandbox)?.archiveAfter ?? null;
            } catch (error) {
              if (!(error instanceof BoatProviderError && error.code === "BOAT_SNAPSHOT_EXPIRED")) throw error;
              this.logger.warn("boat: stopped VM disk expired after 14 days; creating a fresh VM", { ...context, sandboxId: target.id });
            }
          }
          if (!resumed) {
            if (!sandbox) await this.guardBudget(config, context);
            // Same key + same body on a retry returns the same sandbox and does not spend a start.
            const idempotencyKey = `pcboat-${createHash("sha256").update(`${name}\u0000${params.runId}`).digest("hex").slice(0, 40)}`;
            const response = await this.startCall("create", config, () =>
              api.create({
                idempotencyKey,
                type: config.size,
                ttlSeconds,
                monitoring: config.monitoring,
                failFast: config.failFast,
                env: { PAPERCLIP_BOAT_VM: name },
                ...(config.noEnv ? { noEnv: true } : {}),
                ...(config.boatEnvironment ? { environment: config.boatEnvironment } : {}),
                ...(config.templateSnapshot ? { from: config.templateSnapshot } : {}),
              }),
            );
            const created = toView((response as { sandbox?: unknown } | null)?.sandbox);
            if (!created) throw new BoatProviderError("BOAT_START_FAILED", "boat create returned no sandbox.");
            sandboxId = created.id;
            startKind = config.templateSnapshot ? "create_from_snapshot" : "create";
            startedNew = true;
            archiveAfter = created.archiveAfter;
            try {
              await api.update({ sandboxId, name });
            } catch (error) {
              this.logger.warn("boat: could not name the new VM (non-fatal)", { sandboxId, error: errorText(error) });
            }
          }
        }

        this.sandboxCompany.set(sandboxId, params.companyId);
        this.lastActivity.set(sandboxId, this.now());
        if (hardDeadlineMs != null && !Number.isNaN(hardDeadlineMs)) this.hardDeadlines.set(sandboxId, hardDeadlineMs);
        this.noteDeadline(sandboxId, archiveAfter);
        // Persist the mapping before waiting, so a crash cannot orphan a billing VM.
        await this.store.update(params.companyId, (state) =>
          this.upsertOnStart(state, {
            key,
            kind,
            sandboxId,
            name,
            params,
            config,
            startKind: startKind!,
            startedNew,
            archiveAfter,
            hardDeadlineMs,
          }),
        );
        this.logger.info(`boat: VM ${startKind!} for run`, { ...context, sandboxId, size: config.size, startedNew });

        const ready = toView(await waitReady(api, sandboxId, { timeoutMs: config.timeoutMs }));
        if (ready?.archiveAfter) this.noteDeadline(sandboxId, ready.archiveAfter);
        const session = this.ssh.getSession(sandboxId) ?? (await this.openSsh(api, config, sandboxId));
        const remote = await this.prepareRemote(config, session);
        // Before the lease goes back to Paperclip, which then syncs the run's runtime assets (the MCP config with the run JWT among them).
        const runtimeDir = await this.prepareRuntimeDir(session, remote.remoteCwd);
        if (startKind! === "reuse_running") await this.maybeExtend(config, sandboxId);
        await this.store.update(params.companyId, (state) => {
          const record = state.vms[key];
          if (record) {
            record.status = "running";
            record.archiveAfter = ready?.archiveAfter ?? record.archiveAfter;
            record.remoteRoots = mergeRemoteRoot(record.remoteRoots, remote.remoteCwd);
          }
        });
        this.knownRoots.set(sandboxId, new Set([...(this.knownRoots.get(sandboxId) ?? []), remote.remoteCwd]));
        const lease: PluginEnvironmentLease = {
          providerLeaseId: sandboxId,
          metadata: {
            provider: "boat",
            sandboxId,
            sandboxName: name,
            vmKey: key,
            vmKeyKind: kind,
            size: config.size,
            taskClass,
            sizeChoice: { ...sizeChoice },
            runId: params.runId,
            startKind: startKind!,
            remoteCwd: remote.remoteCwd,
            runtimeDir,
            shellCommand: remote.shellCommand,
            tunnel: session.tunnel,
          },
        };
        if (hardDeadlineMs != null && !Number.isNaN(hardDeadlineMs)) {
          const deadline = this.deadlines.get(sandboxId);
          lease.expiresAt = deadline != null ? new Date(Math.min(deadline, hardDeadlineMs)).toISOString() : null;
        }
        return lease;
      } catch (error) {
        // The VM's record as stored, for the workspace roots earlier runs (and other workers) recorded on it.
        let stored: VmRecord | null = null;
        if (sandboxId) {
          stored = await this.store
            .update(params.companyId, (state) => {
              const record = state.vms[key];
              if (record) {
                record.activeRunIds = record.activeRunIds.filter((id) => id !== params.runId);
                const open = record.sessions.find((entry) => entry.runId === params.runId && !entry.endedAt);
                if (open) open.endedAt = this.nowIso();
              }
              const own = findBySandboxId(state, sandboxId);
              return own ? structuredClone(own) : null;
            })
            .catch(() => null);
        }
        if (startedNew && sandboxId) {
          // Never leave a VM billing after a failed start. A resumed disk can
          // still hold an earlier run's MCP config, so scrub first when SSH
          // works, in every root the VM's record knows of.
          const scrub = await this.scrubRuntimeSecrets({
            api,
            config,
            sandboxId,
            roots: this.runtimeRoots(config, sandboxId, null, stored),
            before: "stop",
            connect: false,
          });
          await this.ssh.closeSession(sandboxId).catch(() => undefined);
          // A runtime directory that failed on the VM fails again at every resume of this disk; a fresh VM does not.
          const linkFailed = error instanceof BoatProviderError && error.code === "BOAT_RUNTIME_DIR_FAILED" && error.details.onVm === true;
          const reason =
            scrub.status === "failed" || (scrub.status === "incomplete" && !linkFailed)
              ? unverifiedScrubReason(scrub)
              : linkFailed
                ? "its .paperclip-runtime could not be prepared (~/.boatignore rule, real directory)"
                : null;
          let deleted = false;
          if (reason && resumedExisting) {
            // The card's own VM: stop it and keep its work (TOG-37714). Its next start links and scrubs again.
            this.logKeptDisk({ sandboxId, trigger: "failed start", keep: "resumed_disk", reason });
          } else if (reason && scrub.status === "incomplete" && !linkFailed) {
            this.logKeptDisk({ sandboxId, trigger: "failed start", keep: "incomplete_scan", reason });
          } else if (reason) {
            // A VM this start created holds nothing of the card's yet.
            deleted = await this.deleteInsteadOfStop({ api, config, companyId: params.companyId, sandboxId, runId: params.runId, trigger: "failed start", reason });
          }
          if (!deleted) {
            await this.stopAndConfirm(this.opsApi(config), sandboxId, 30_000).catch(() => false);
            await this.store
              .update(params.companyId, (state) => {
                const record = state.vms[key];
                if (record && record.sandboxId === sandboxId) {
                  record.status = "stopped";
                  record.lastStoppedAt = this.nowIso();
                }
              })
              .catch(() => undefined);
          }
        }
        throw error;
      }
    });
  }

  private upsertOnStart(
    state: StateDoc,
    input: {
      key: string;
      kind: VmKeyKind;
      sandboxId: string;
      name: string;
      params: PluginEnvironmentAcquireLeaseParams;
      config: BoatDriverConfig;
      startKind: StartKind;
      startedNew: boolean;
      archiveAfter: string | null;
      hardDeadlineMs: number | null;
    },
  ): void {
    const now = this.nowIso();
    const previous = state.vms[input.key];
    if (previous && previous.sandboxId !== input.sandboxId) {
      // The old VM was replaced (expired or gone): keep it as a tombstone for accounting.
      state.vms[`${input.key}~${previous.sandboxId}`] = { ...previous, status: "deleted", deletedAt: previous.deletedAt ?? now };
    }
    const record: VmRecord =
      previous && previous.sandboxId === input.sandboxId
        ? previous
        : {
            key: input.key,
            keyKind: input.kind,
            sandboxId: input.sandboxId,
            name: input.name,
            companyId: input.params.companyId,
            environmentId: input.params.environmentId,
            issueId: input.params.issueId ?? null,
            executionWorkspaceId: input.params.executionWorkspaceId ?? null,
            size: input.config.size,
            status: "starting",
            activeRunIds: [],
            createdAt: now,
            lastStartedAt: now,
            lastStoppedAt: null,
            lastActivityAt: now,
            archiveAfter: null,
            hardDeadline: null,
            starts: 0,
            lifetimeUsage: null,
            sessions: [],
            deletedAt: null,
          };
    record.status = input.startKind === "reuse_running" ? "running" : "starting";
    record.size = input.config.size;
    record.issueId = input.params.issueId ?? record.issueId;
    record.lastActivityAt = now;
    record.archiveAfter = input.archiveAfter ?? record.archiveAfter;
    record.hardDeadline = input.hardDeadlineMs != null && !Number.isNaN(input.hardDeadlineMs) ? new Date(input.hardDeadlineMs).toISOString() : null;
    if (input.startedNew) {
      record.starts += 1;
      record.lastStartedAt = now;
    }
    if (!record.activeRunIds.includes(input.params.runId)) record.activeRunIds.push(input.params.runId);
    const session: RunSession = {
      runId: input.params.runId,
      agentId: input.params.agentId ?? null,
      startKind: input.startKind,
      size: input.config.size,
      startedAt: now,
      endedAt: null,
      usage: null,
    };
    record.sessions.push(session);
    state.vms[input.key] = record;
  }

  async resumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    // The same protocol as acquire: under the card (and name) lock, so a release, a capture or the
    // sweep of this card finishes first, and a stop boat is still saving is waited for (bounded).
    const vmKey = await this.vmKeyFor(params.companyId, params.providerLeaseId, params.leaseMetadata);
    const sandboxName = str(params.leaseMetadata?.sandboxName);
    return await this.withVmLocks(params.companyId, vmKey, sandboxName, () => this.resumeLeaseLocked(params, config));
  }

  private async resumeLeaseLocked(params: PluginEnvironmentResumeLeaseParams, config: BoatDriverConfig): Promise<PluginEnvironmentLease> {
    const api = this.opsApi(config);
    let sandbox = await this.getSandbox(api, params.providerLeaseId);
    // A stop (release, the sweep, auto-stop) is still saving the disk; boat refuses a resume until it ends.
    if (sandbox?.state === "archiving") sandbox = await this.waitUntilStopped(api, sandbox, config.stopConfirmTimeoutMs);
    if (!sandbox || sandbox.dataExpiredAt || sandbox.state === "cancelled") {
      return { providerLeaseId: null, metadata: { provider: "boat", expired: true } };
    }
    const sandboxId = sandbox.id;
    this.sandboxCompany.set(sandboxId, params.companyId);
    const wasUp = UP_STATES.has(sandbox.state);
    const taskClass = parseTaskClass(params.leaseMetadata?.taskClass, config.taskClass);
    const runningSize = sandbox.state !== "archived" ? requireBoatSize(sandbox.type) : undefined;
    const sizeChoice = selectSize(config, taskClass, runningSize);
    config.size = sizeChoice.size;
    this.logger.info("boat: size choice for lease", { sandboxId, ...sizeChoice });
    this.warnUnmeasuredSmall(sizeChoice);
    const session = await this.liveSession(config, params.companyId, sandboxId, true);
    const remote = await this.prepareRemote(config, session);
    const remoteCwd = str(params.leaseMetadata?.remoteCwd) ?? remote.remoteCwd;
    // Before Paperclip syncs this run's runtime assets: the `.boatignore` rule and the directory must be in place.
    const runtimeDir = await this.prepareRuntimeDir(session, remoteCwd);
    // Paperclip resumes a reusable lease without naming the new run, so record
    // the run window under a synthetic id: it gives per-run cost accounting.
    // It is not added to activeRunIds, so release still stops the VM.
    await this.store
      .update(params.companyId, (doc) => {
        const record = findBySandboxId(doc, sandboxId);
        if (!record) return;
        const now = this.nowIso();
        record.status = "running";
        record.lastActivityAt = now;
        record.size = config.size;
        record.remoteRoots = mergeRemoteRoot(record.remoteRoots, remoteCwd);
        record.sessions.push({
          runId: `resumed-lease:${now}`,
          agentId: null,
          startKind: wasUp ? "reuse_running" : "resume",
          size: record.size,
          startedAt: now,
          endedAt: null,
          usage: null,
        });
      })
      .catch((error) => this.logger.warn("boat: could not record the resumed run window", { sandboxId, error: errorText(error) }));
    return {
      providerLeaseId: sandboxId,
      metadata: {
        ...(params.leaseMetadata ?? {}),
        provider: "boat",
        sandboxId,
        remoteCwd,
        runtimeDir,
        shellCommand: remote.shellCommand,
        tunnel: session.tunnel,
        resumedLease: true,
        size: config.size,
        taskClass,
        sizeChoice: { ...sizeChoice },
      },
    };
  }

  /** An SSH session to a running VM. Resumes a stopped VM first (budget-guarded): auto-stop or the sweep may have stopped it. */
  private async liveSession(config: BoatDriverConfig, companyId: string, sandboxId: string, resize = false): Promise<SshSession> {
    const existing = this.ssh.getSession(sandboxId);
    if (existing) return existing;
    return await this.withLock(`sandbox:${sandboxId}`, async () => {
      const again = this.ssh.getSession(sandboxId);
      if (again) return again;
      const api = this.opsApi(config);
      let sandbox = await this.getSandbox(api, sandboxId);
      // boat refuses a resume while a stop is still saving the disk: wait for it (bounded, BOAT_STOP_PENDING).
      if (sandbox?.state === "archiving") sandbox = await this.waitUntilStopped(api, sandbox, config.stopConfirmTimeoutMs);
      if (!sandbox || sandbox.dataExpiredAt || sandbox.state === "cancelled") {
        throw new BoatProviderError("BOAT_VM_GONE", `boat VM ${sandboxId} no longer exists; the run must acquire a new lease.`);
      }
      const resumed = !UP_STATES.has(sandbox.state);
      if (resumed) {
        // Mid-lease reconnects keep their actual size; only a new lease may resize an archived VM.
        const size = resize && sandbox.state === "archived" ? config.size : requireBoatSize(sandbox.type);
        const startConfig = { ...config, size };
        await this.guardBudget(startConfig, { sandboxId, reason: "resume_for_execute" });
        const response = await this.startCall(
          "resume",
          startConfig,
          () =>
            api.resume({
              sandboxId,
              failFast: config.failFast,
              ttlSeconds: this.ttlSeconds(config, this.hardDeadlines.get(sandboxId) ?? null),
              ...(size !== sandbox.type && sandbox.state === "archived" ? { type: size } : {}),
            }),
          async () => {
            const now = await this.getSandbox(api, sandboxId);
            return !!now && UP_STATES.has(now.state);
          },
        );
        this.noteDeadline(sandboxId, toView((response as { sandbox?: unknown } | null)?.sandbox)?.archiveAfter ?? null);
        this.logger.info("boat: resumed a stopped VM for a command", { sandboxId, previousState: sandbox.state });
        await this.store
          .update(companyId, (state) => {
            const record = findBySandboxId(state, sandboxId);
            if (!record) return;
            record.status = "running";
            record.size = size;
            record.starts += 1;
            record.lastStartedAt = this.nowIso();
          })
          .catch(() => undefined);
      } else {
        this.noteDeadline(sandboxId, sandbox.archiveAfter);
      }
      const ready = toView(await waitReady(api, sandboxId, { timeoutMs: config.timeoutMs }));
      if (ready?.archiveAfter) this.noteDeadline(sandboxId, ready.archiveAfter);
      const session = await this.openSsh(api, config, sandboxId);
      // This path (a resume for a command, or a new worker) skips acquire's setup step, and a resume
      // may give ~/.bashrc its ASCII_TOKEN line back, so scrub it here too.
      await this.ssh.run(session, `sh -c ${shellQuote(SCRUB_BASHRC_ASCII_TOKEN)}`, { timeoutMs: 30_000 }).catch(() => undefined);
      if (resumed) await this.reprepareRuntimeDirs(config, companyId, sandboxId, session);
      else {
        await this.store
          .update(companyId, (state) => {
            const record = findBySandboxId(state, sandboxId);
            if (record?.status === "stopping") record.status = "running";
          })
          .catch(() => undefined);
      }
      return session;
    });
  }

  /** Poll a stopping VM until boat reports it stopped. Throws when the stop does not end in time. */
  private async waitUntilStopped(api: BoatApiLike, sandbox: SandboxView, timeoutMs: number): Promise<SandboxView | null> {
    const deadline = this.now() + timeoutMs;
    let current: SandboxView | null = sandbox;
    while (current && current.state === "archiving") {
      if (this.now() >= deadline) {
        throw new BoatProviderError(
          "BOAT_STOP_PENDING",
          `boat VM ${sandbox.id} is still stopping after ${Math.round(timeoutMs / 1000)} s; the run cannot resume it yet.`,
        );
      }
      await this.sleep(STOP_POLL_INTERVAL_MS);
      current = await this.getSandbox(api, sandbox.id);
    }
    return current;
  }

  /**
   * Ask boat to stop once, without waiting for the snapshot save (4-65 s).
   * Release uses this and returns at once; the idle sweep confirms the stop.
   * A slow release keeps the Paperclip lease active while its run is terminal,
   * and Paperclip's orphan-lease sweep then destroys the warm VM.
   */
  private async requestStop(api: BoatApiLike, sandboxId: string): Promise<{ accepted: boolean; gone: boolean }> {
    try {
      await api.stop({ sandboxId });
      return { accepted: true, gone: false };
    } catch (error) {
      const info = await describeBoatError(error);
      if (info.status === 404) return { accepted: true, gone: true };
      if (info.status === 409 && ["sandbox_stopping", "sandbox_not_ready", "machine_not_running"].includes(info.code ?? "")) {
        return { accepted: true, gone: false };
      }
      this.logger.warn("boat: stop call failed", { sandboxId, error: formatBoatError(info) });
      return { accepted: false, gone: false };
    }
  }

  /**
   * After an accepted stop that has not taken effect yet (the VM still looks
   * up), wait briefly for it to leave UP. Returns the last view; on read
   * failure the last known view is kept and retried until the bound, so a
   * persistently unreadable VM reports as still up and the caller falls back.
   */
  private async waitUntilNotUp(api: BoatApiLike, sandboxId: string, first: SandboxView | undefined): Promise<SandboxView | null | undefined> {
    let current: SandboxView | null | undefined = first;
    const deadline = this.now() + STOP_ACCEPT_POLL_MS;
    for (;;) {
      if (current === null || (current && !UP_STATES.has(current.state))) return current;
      if (this.now() >= deadline) return current;
      await this.sleep(STOP_POLL_INTERVAL_MS);
      const next = await this.getSandbox(api, sandboxId).catch(() => undefined);
      if (next !== undefined) current = next;
    }
  }

  /** Stop, then poll until boat reports `archived` (billing has stopped). Returns false when not confirmed in time. */
  private async stopAndConfirm(api: BoatApiLike, sandboxId: string, timeoutMs: number): Promise<boolean> {
    try {
      await api.stop({ sandboxId });
    } catch (error) {
      const info = await describeBoatError(error);
      if (info.status === 404) return true;
      if (!(info.status === 409 && ["sandbox_stopping", "sandbox_not_ready", "machine_not_running"].includes(info.code ?? ""))) {
        this.logger.warn("boat: stop call failed", { sandboxId, error: formatBoatError(info) });
      }
    }
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.getSandbox(api, sandboxId).catch(() => undefined);
      if (sandbox === null) return true;
      if (sandbox && (sandbox.state === "archived" || sandbox.state === "cancelled")) return true;
      if (sandbox?.stopStatus === "failing") {
        // boat refused the stop because the save failed; it retries by itself and
        // does not bill while the stop waits (docs.boat.dev/snapshots/stop).
        this.logger.warn("boat: stop is pending because the snapshot save failed; boat retries and the meter is paused", { sandboxId });
      }
      if (this.now() >= deadline) return false;
      await this.sleep(STOP_POLL_INTERVAL_MS);
    }
  }

  private async readUsage(
    config: BoatDriverConfig,
    sandboxId: string,
    window: { since?: string; until?: string },
    size: BoatSize,
  ): Promise<UsageReading> {
    try {
      const response = (await this.costApi(config).usage({ sandboxId, ...window })) as { seconds?: number; dollars?: number };
      if (typeof response.seconds === "number" && typeof response.dollars === "number") {
        return { seconds: response.seconds, dollars: response.dollars, source: "boat", at: this.nowIso() };
      }
    } catch (error) {
      this.logger.warn("boat: usage read failed; using a list-price estimate", { sandboxId, error: errorText(error) });
    }
    if (!window.since) return { seconds: 0, dollars: 0, source: "estimate", at: this.nowIso() };
    const seconds = Math.max(0, ((window.until ? Date.parse(window.until) : this.now()) - Date.parse(window.since)) / 1000);
    return { seconds, dollars: (seconds / 3600) * PRICE_PER_HOUR[size], source: "estimate", at: this.nowIso() };
  }

  private async recordStopUsage(config: BoatDriverConfig, companyId: string, sandboxId: string, runId: string | null): Promise<void> {
    const doc = await this.store.read(companyId);
    const record = findBySandboxId(doc, sandboxId);
    if (!record) return;
    const endedAt = this.nowIso();
    const open = record.sessions.filter((entry) => !entry.endedAt && (runId == null || entry.runId === runId || record.activeRunIds.length === 0));
    const readings = new Map<string, UsageReading>();
    for (const entry of open) {
      readings.set(`${entry.runId}\u0000${entry.startedAt}`, await this.readUsage(config, sandboxId, { since: entry.startedAt, until: endedAt }, entry.size));
    }
    const lifetime = await this.readUsage(config, sandboxId, {}, record.size);
    await this.store.update(companyId, (state) => {
      const current = findBySandboxId(state, sandboxId);
      if (!current) return;
      for (const entry of current.sessions) {
        const reading = readings.get(`${entry.runId}\u0000${entry.startedAt}`);
        if (reading && !entry.endedAt) {
          entry.endedAt = endedAt;
          entry.usage = reading;
        }
      }
      if (lifetime.source === "boat") current.lifetimeUsage = lifetime;
    });
  }

  async release(
    params: PluginEnvironmentReleaseLeaseParams,
    mode: "release" | "stop",
  ): Promise<PluginEnvironmentTerminationReceipt | undefined> {
    const sandboxId = params.providerLeaseId;
    if (!sandboxId) {
      if (mode === "stop") throw new BoatProviderError("BOAT_NO_LEASE", "no provider lease id to stop.");
      return undefined;
    }
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    const runId = str(params.leaseMetadata?.runId);
    const api = this.opsApi(config);

    return await this.withCardLock(params.companyId, sandboxId, params.leaseMetadata, () => this.withLock(`sandbox:${sandboxId}`, async () => {
      const snapshot = await this.store.update(params.companyId, (doc) => {
        const record = findBySandboxId(doc, sandboxId);
        if (!record) return null;
        if (runId) record.activeRunIds = record.activeRunIds.filter((id) => id !== runId);
        else if (mode === "stop" || params.cancelActiveWork) record.activeRunIds = [];
        return { keyKind: record.keyKind, othersActive: record.activeRunIds.length, size: record.size, record: structuredClone(record) };
      });
      const forced = mode === "stop" || params.cancelActiveWork === true || params.resourceDisposition === "stop_and_retain";
      if (snapshot && snapshot.othersActive > 0 && !forced) {
        this.logger.info("boat: run released; VM stays up for another active run on the same card", { sandboxId, runId });
        if (runId) await this.recordRunEnd(config, params.companyId, sandboxId, runId);
        return undefined;
      }

      // Before the stop (or delete): the stop snapshot must not keep the run JWT
      // that Paperclip left in the VM as the run's MCP config. A failed scrub
      // does not keep the VM running (that would bill and keep the token
      // live), and does not stop it either: the VM is deleted instead. Except
      // where the disk must be kept (logKeptDisk): StopLease, stop_and_retain,
      // a forced stop of a VM that another run on the card still holds, and a
      // scrub that found nothing left but could not search the whole disk
      // (incomplete: unverified, but no evidence to destroy the card's work on).
      const deleting = snapshot?.keyKind === "run" && mode === "release" && params.resourceDisposition !== "stop_and_retain";
      const keep: KeptDiskReason | null =
        mode === "stop"
          ? "stop_lease"
          : params.resourceDisposition === "stop_and_retain"
            ? "stop_and_retain"
            : (snapshot?.othersActive ?? 0) > 0
              ? "held_lease"
              : null;
      const scrub = await this.scrubRuntimeSecrets({
        api,
        config,
        sandboxId,
        roots: this.runtimeRoots(config, sandboxId, params.leaseMetadata, snapshot?.record ?? null),
        before: deleting ? "delete" : "stop",
        connect: true,
      });
      await this.ssh.closeSession(sandboxId);
      this.clearExtendTimer(sandboxId);
      this.inflight.delete(sandboxId);
      this.envDropsLogged.delete(sandboxId);

      if (!deleting && scrubUnverified(scrub)) {
        const trigger = mode === "stop" ? "stop lease" : "release";
        const reason = unverifiedScrubReason(scrub);
        if (keep || scrub.status === "incomplete") {
          this.logKeptDisk({ sandboxId, trigger, keep: keep ?? "incomplete_scan", reason });
        } else if (await this.deleteInsteadOfStop({ api, config, companyId: params.companyId, sandboxId, runId, trigger, reason })) {
          return { providerLeaseId: sandboxId, state: "destroyed" };
        }
      }

      if (deleting) {
        // A run-keyed VM can never be reused, so there is nothing to keep: delete it.
        await this.recordStopUsage(config, params.companyId, sandboxId, runId).catch(() => undefined);
        await this.deleteSandbox(api, sandboxId);
        await this.markDeleted(params.companyId, sandboxId);
        this.logger.info("boat: deleted per-run VM on release", { sandboxId, runId });
        return { providerLeaseId: sandboxId, state: "destroyed" };
      }

      // Return as soon as boat accepts the stop and the VM leaves UP: SSH is
      // closed and no more commands can run, so execution has ended even while
      // boat is still saving the snapshot (4-65 s). Waiting for the save here
      // keeps the Paperclip lease active past its run, and the orphan-lease
      // sweep then destroys the warm VM. The idle sweep confirms the save.
      const stop = await this.requestStop(api, sandboxId);
      let current = await this.getSandbox(api, sandboxId).catch(() => undefined);
      if (stop.accepted && !stop.gone && (current === undefined || (current && UP_STATES.has(current.state)))) {
        current = await this.waitUntilNotUp(api, sandboxId, current);
      }
      const stillUp = !stop.gone && (current === undefined || (current !== null && UP_STATES.has(current.state)));
      const alreadyStopped = stop.gone || current === null || current?.state === "archived" || current?.state === "cancelled";
      if ((alreadyStopped || stop.accepted) && !stillUp) {
        await this.store
          .update(params.companyId, (doc) => {
            const record = findBySandboxId(doc, sandboxId);
            if (!record) return;
            record.status = alreadyStopped ? "stopped" : "stopping";
            record.lastStoppedAt = this.nowIso();
            record.lastActivityAt = this.nowIso();
            // Only a confirmed-down VM clears the other runs: they may still
            // hold the lease while the save is pending, and clearing them
            // would let the sweep idle-stop or delete under them.
            if (alreadyStopped) record.activeRunIds = [];
          })
          .catch(() => undefined);
        await this.recordStopUsage(config, params.companyId, sandboxId, runId).catch((error) =>
          this.logger.warn("boat: could not record usage after stop", { sandboxId, error: errorText(error) }),
        );
        if (alreadyStopped) {
          this.logger.info("boat: stopped VM on release (billing stopped)", { sandboxId, runId });
        } else {
          this.logger.info("boat: stop accepted on release; the sweep confirms the snapshot save", {
            sandboxId,
            runId,
            state: current?.state ?? "unknown",
          });
        }
        return { providerLeaseId: sandboxId, state: "stopped" };
      }
      // The stop was refused, or it did not take effect: mark stopping so the
      // sweep retries the stop instead of waiting for the idle thresholds.
      await this.store
        .update(params.companyId, (doc) => {
          const record = findBySandboxId(doc, sandboxId);
          if (!record) return;
          record.status = "stopping";
          record.lastStoppedAt = this.nowIso();
          record.lastActivityAt = this.nowIso();
        })
        .catch(() => undefined);
      if (mode === "stop" || params.cancelActiveWork) {
        throw new BoatProviderError(
          "BOAT_STOP_UNCONFIRMED",
          `boat did not confirm VM ${sandboxId} left UP (still up or status unreadable); the idle sweep retries the stop.`,
        );
      }
      this.logger.warn("boat: stop did not take effect; the sweep retries it", { sandboxId, stillUp });
      return undefined;
    }));
  }

  private async recordRunEnd(config: BoatDriverConfig, companyId: string, sandboxId: string, runId: string): Promise<void> {
    const doc = await this.store.read(companyId);
    const record = findBySandboxId(doc, sandboxId);
    const entry = record?.sessions.find((item) => item.runId === runId && !item.endedAt);
    if (!record || !entry) return;
    const endedAt = this.nowIso();
    const reading = await this.readUsage(config, sandboxId, { since: entry.startedAt, until: endedAt }, entry.size);
    await this.store.update(companyId, (state) => {
      const current = findBySandboxId(state, sandboxId);
      const open = current?.sessions.find((item) => item.runId === runId && !item.endedAt);
      if (open) {
        open.endedAt = endedAt;
        open.usage = reading;
      }
      if (current) current.lastActivityAt = endedAt;
    });
  }

  private async deleteSandbox(api: BoatApiLike, sandboxId: string): Promise<void> {
    try {
      await api.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
    } catch (error) {
      const info = await describeBoatError(error);
      if (info.status === 404) return;
      throw new BoatProviderError("BOAT_DELETE_FAILED", `boat delete of VM ${sandboxId} failed: ${formatBoatError(info)}`);
    }
  }

  private async markDeleted(companyId: string, sandboxId: string): Promise<void> {
    await this.store.update(companyId, (doc) => {
      for (const [key, record] of Object.entries(doc.vms)) {
        if (record.sandboxId !== sandboxId) continue;
        const now = this.nowIso();
        delete doc.vms[key];
        const tombstoneKey = key.includes("~") ? key : `${key}~${sandboxId}`;
        doc.vms[tombstoneKey] = {
          ...record,
          status: "deleted",
          deletedAt: now,
          activeRunIds: [],
          sessions: record.sessions.map((entry) => (entry.endedAt ? entry : { ...entry, endedAt: now })),
        };
      }
    });
    this.deadlines.delete(sandboxId);
    this.hardDeadlines.delete(sandboxId);
    this.lastActivity.delete(sandboxId);
    this.envDropsLogged.delete(sandboxId);
    this.knownRoots.delete(sandboxId);
  }

  async destroy(params: PluginEnvironmentDestroyLeaseParams): Promise<PluginEnvironmentTerminationReceipt | undefined> {
    const sandboxId = params.providerLeaseId;
    if (!sandboxId) return undefined;
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    const api = this.opsApi(config);
    return await this.withCardLock(params.companyId, sandboxId, params.leaseMetadata, () => this.withLock(`sandbox:${sandboxId}`, async () => {
      // The delete removes the disk, but a delete that fails leaves the VM as it
      // is, so remove the run JWT first, the same as before a stop.
      const record = await this.store
        .read(params.companyId)
        .then((doc) => findBySandboxId(doc, sandboxId))
        .catch(() => null);
      await this.scrubRuntimeSecrets({
        api,
        config,
        sandboxId,
        roots: this.runtimeRoots(config, sandboxId, params.leaseMetadata, record),
        before: "delete",
        connect: true,
      });
      await this.ssh.closeSession(sandboxId);
      this.clearExtendTimer(sandboxId);
      this.inflight.delete(sandboxId);
      this.envDropsLogged.delete(sandboxId);
      await this.recordStopUsage(config, params.companyId, sandboxId, null).catch(() => undefined);
      await this.deleteSandbox(api, sandboxId);
      await this.markDeleted(params.companyId, sandboxId);
      this.logger.info("boat: deleted VM (destroy lease) and forgot its card mapping", { sandboxId });
      return { providerLeaseId: sandboxId, state: "destroyed" };
    }));
  }

  async realizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      str(params.lease.metadata?.remoteCwd) ?? params.workspace.remotePath ?? config.remoteWorkspaceDir ?? "/home/user/paperclip-workspace";
    const sandboxId = params.lease.providerLeaseId;
    if (sandboxId) {
      const session = await this.liveSession(config, params.companyId, sandboxId);
      // mkdir -p the workspace and its .paperclip-runtime (kept when acquire already made it), left out of snapshots by ~/.boatignore, before Paperclip syncs into it.
      const runtimeDir = await this.prepareRuntimeDir(session, remoteCwd);
      // Paperclip puts its runtime assets (the run MCP config among them) under this root.
      await this.rememberRemoteRoot(params.companyId, sandboxId, remoteCwd);
      return { cwd: remoteCwd, metadata: { provider: "boat", remoteCwd, runtimeDir } };
    }
    return { cwd: remoteCwd, metadata: { provider: "boat", remoteCwd } };
  }

  async sync(params: PluginEnvironmentSyncInParams | PluginEnvironmentSyncOutParams, direction: "in" | "out"): Promise<PluginEnvironmentSyncResult> {
    const sandboxId = params.lease.providerLeaseId;
    if (!sandboxId) throw new Error("No provider lease ID available for native sync.");
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    // Like Execute, wait for a sweep already scrubbing/stopping this card.
    await this.withCardLock(params.companyId, sandboxId, params.lease.metadata, async () => {
      await this.beginActivity(config, params.companyId, sandboxId);
    });
    const startedAt = this.now();
    try {
      let session = await this.liveSession(config, params.companyId, sandboxId);
      if (!this.ssh.masterAlive(session)) {
        if (await this.sessionLost(config, sandboxId)) session = await this.liveSession(config, params.companyId, sandboxId);
        else await this.ssh.ensureMaster(session);
      }
      await this.maybeExtend(config, sandboxId);
      const remoteRoot = str(params.lease.metadata?.remoteCwd) ?? config.remoteWorkspaceDir ?? "/home/user/paperclip-workspace";
      const result = await syncFiles({
        ssh: this.ssh, session, timeoutMs: config.timeoutMs, remoteRoot,
        onDirectoryReplaced: async (target) => {
          if (remoteRoot === target || remoteRoot.startsWith(`${target}/`)) {
            // A directory mapping destroys the previous workspace, including
            // its VM-owned runtime directory. Restore it before later assets
            // or post-upload commands can place credentials there again.
            await this.prepareRuntimeDir(session, remoteRoot);
          }
        },
      }, direction, params.operations);
      this.logger.info("boat: native workspace sync completed", {
        sandboxId, direction, durationMs: this.now() - startedAt,
        filesTransferred: result.operations.reduce((sum, op) => sum + op.filesTransferred, 0),
        bytesTransferred: result.operations.reduce((sum, op) => sum + op.bytesTransferred, 0),
      });
      return result;
    } finally {
      await this.endActivity(params.companyId, sandboxId);
    }
  }

  async execute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
    const sandboxId = params.lease.providerLeaseId;
    if (!sandboxId) {
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "No provider lease ID available for execution." };
    }
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    if (isAcpProcessSessionCommand(params.command, params.args ?? [], params.env)) {
      // The ACP launcher starts the agent from an envelope (inline, or uploaded
      // as command.b64 in chunks) that holds the unfiltered launch env, so the
      // allowlist below would never see it. Refuse every step of it. The
      // command itself is not logged: its arguments can be envelope chunks.
      this.logger.warn("boat: refused a Paperclip ACP process-session command", { sandboxId });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr:
          "boat: refused a Paperclip ACP process-session command. That launcher starts the agent from an envelope (PAPERCLIP_PROCESS_SESSION_COMMAND_B64, or a command.b64 file it uploads under process-sessions/) that holds the run's whole environment, which this provider cannot filter. Set the agent's engine to cli on boat environments.",
        metadata: { provider: "boat", sandboxId, error: "BOAT_ACP_PROCESS_SESSION_REFUSED" },
      };
    }
    // Default-deny env (env-policy.ts): only allowlisted names reach the VM.
    const { kept: envEntries, dropped } = filterRunEnv(params.env, effectiveEnvAllowlist(config.envAllowlist));
    assertValidEnvKeys(envEntries);
    if (dropped.length > 0) this.logEnvDrops(sandboxId, dropped);
    const timeoutMs = params.timeoutMs ?? config.timeoutMs;
    const cwd = params.cwd ?? str(params.lease.metadata?.remoteCwd) ?? undefined;

    // Admit work under the sweep's card lock, but release it before running:
    // a sweep already scrubbing/stopping must finish first; a later sweep
    // sees inflight and leaves this command alone. Commands can still overlap.
    await this.withCardLock(params.companyId, sandboxId, params.lease.metadata, async () => {
      await this.beginActivity(config, params.companyId, sandboxId);
    });
    try {
      let session: SshSession;
      try {
        session = await this.liveSession(config, params.companyId, sandboxId);
      } catch (error) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `boat: ${errorText(error)}`,
          metadata: { provider: "boat", sandboxId, error: error instanceof BoatProviderError ? error.code : "BOAT_ERROR" },
        };
      }
      if (!this.ssh.masterAlive(session)) {
        // A dead master usually means the VM stopped (auto-stop deadline or
        // sweep). Check that with one GET before trying to reconnect.
        if (await this.sessionLost(config, sandboxId)) {
          try {
            session = await this.liveSession(config, params.companyId, sandboxId);
          } catch (error) {
            return {
              exitCode: 1,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: `boat: ${errorText(error)}`,
              metadata: { provider: "boat", sandboxId, error: error instanceof BoatProviderError ? error.code : "BOAT_ERROR" },
            };
          }
        } else {
          await this.ssh.ensureMaster(session);
        }
      }
      await this.maybeExtend(config, sandboxId);

      // Env values never ride argv: they go over the ssh stdin pipe into a
      // 0600 file (exe-dev rule). The file sits in a fresh 0700 directory
      // under /tmp, outside the git checkout and outside every boat snapshot,
      // and the command script removes it before the payload starts (shell.ts).
      let remoteEnv: RemoteEnvStage | null = null;
      if (envEntries.length > 0) {
        remoteEnv = newRemoteEnvStage();
        let staged = await this.ssh.run(session, stageRemoteEnvCommand(remoteEnv), {
          stdin: buildRemoteEnvFileContents(envEntries),
          timeoutMs,
        });
        if (staged.exitCode === 255 && (await this.sessionLost(config, sandboxId))) {
          // The VM was stopped under us (auto-stop or sweep). Nothing ran yet,
          // so resume and stage again once, in a new directory.
          session = await this.liveSession(config, params.companyId, sandboxId);
          remoteEnv = newRemoteEnvStage();
          staged = await this.ssh.run(session, stageRemoteEnvCommand(remoteEnv), {
            stdin: buildRemoteEnvFileContents(envEntries),
            timeoutMs,
          });
        }
        if (staged.timedOut || staged.exitCode !== 0) {
          await this.removeStagedEnv(session, remoteEnv);
          return {
            exitCode: 1,
            signal: null,
            timedOut: staged.timedOut,
            stdout: "",
            stderr: `boat: could not stage the run environment on VM ${sandboxId}: ${(staged.stderr || staged.stdout).trim().slice(0, 500)}`,
            metadata: { provider: "boat", sandboxId },
          };
        }
      }

      const script = buildLoginShellScript({ command: params.command, args: params.args ?? [], cwd, remoteEnv });
      // sshd runs this through the user's login shell (`$SHELL -c '<this>'`),
      // which execs `env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`: the shell
      // above the payload never had boat's credentials in its environment,
      // and it exits with the payload's status (128+n for a signal, not 255).
      const result = await this.ssh.run(session, buildRemoteCommand(script), { stdin: params.stdin, timeoutMs });
      let stderr = result.stderr;
      if (result.exitCode === 255) {
        if (await this.sessionLost(config, sandboxId)) {
          // A stopped VM loses /tmp, so the env file is gone with it.
          stderr = `${stderr}\nboat: VM ${sandboxId} was stopped while the command ran (auto-stop deadline or idle sweep). The next command resumes it.`.trim();
        } else if (remoteEnv) {
          // ssh may have failed before the script could remove the file.
          await this.removeStagedEnv(session, remoteEnv);
        }
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr,
        metadata: { provider: "boat", sandboxId, tunnel: session.tunnel },
      };
    } finally {
      await this.endActivity(params.companyId, sandboxId);
    }
  }

  /** Logs dropped env names (never values), once per distinct set per VM. */
  private logEnvDrops(sandboxId: string, dropped: EnvDrop[]): void {
    const signature = dropped
      .map((entry) => `${entry.name}:${entry.reason}`)
      .sort()
      .join(",");
    let seen = this.envDropsLogged.get(sandboxId);
    if (!seen) {
      seen = new Set();
      this.envDropsLogged.set(sandboxId, seen);
    }
    if (seen.has(signature)) return;
    seen.add(signature);
    const byReason: Record<string, string[]> = {};
    for (const entry of dropped) (byReason[entry.reason] ??= []).push(entry.name);
    for (const names of Object.values(byReason)) names.sort();
    this.logger.warn(`boat: dropped ${dropped.length} run env key(s) not allowed into the VM (names only)`, {
      sandboxId,
      dropped: byReason,
    });
  }

  /** Best effort: remove a staged env file that the command script may not have reached. */
  private async removeStagedEnv(session: SshSession, stage: RemoteEnvStage): Promise<void> {
    await this.ssh.run(session, removeRemoteEnvCommand(stage), { timeoutMs: 15_000 }).catch(() => undefined);
  }

  /** After an SSH failure: is the VM no longer running? If so, drop the dead session. */
  private async sessionLost(config: BoatDriverConfig, sandboxId: string): Promise<boolean> {
    const sandbox = await this.getSandbox(this.opsApi(config), sandboxId).catch(() => undefined);
    if (sandbox === undefined) return false;
    if (sandbox && UP_STATES.has(sandbox.state)) return false;
    await this.ssh.closeSession(sandboxId);
    return true;
  }

  // ----------------------------------------------------------------- probe

  async probe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    const diagnostics: NonNullable<PluginEnvironmentProbeResult["diagnostics"]> = [];
    let budget: BudgetSnapshot | null = null;
    try {
      budget = await this.readBudget(config);
    } catch (error) {
      diagnostics.push({ severity: "error", code: "boat_limits", message: errorText(error) });
    }
    if (budget) {
      const refusal = checkBudget(budget, config, config.size);
      diagnostics.push(
        refusal
          ? { severity: "warning", code: `budget_${refusal.limit}`, message: `A start would be refused now: ${refusal.message}` }
          : { severity: "info", code: "budget_ok", message: `A start would pass the budget guard. ${budget.trialLine ?? ""}`.trim() },
      );
    }
    const sshCheck = await runProcess("ssh", ["-V"], { timeoutMs: 10_000 }).catch((error) => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: errorText(error),
    }));
    if (sshCheck.exitCode !== 0) {
      diagnostics.push({ severity: "error", code: "ssh_missing", message: `the ssh client is not usable on the plugin host: ${sshCheck.stderr.trim()}` });
    }
    if (config.cliproxyTunnel) {
      const reachable = await tcpReachable(config.tunnelTargetHost, config.tunnelTargetPort, 3000);
      diagnostics.push(
        reachable
          ? { severity: "info", code: "tunnel_target_ok", message: `Tunnel target ${config.tunnelTargetHost}:${config.tunnelTargetPort} answers from the plugin host.` }
          : {
              severity: "error",
              code: "tunnel_target_unreachable",
              message: `Tunnel target ${config.tunnelTargetHost}:${config.tunnelTargetPort} does not answer from the plugin host; agents in the VM could not reach the model proxy.`,
            },
      );
    }
    const ok = !diagnostics.some((entry) => entry.severity === "error");
    return {
      ok,
      summary: ok
        ? "boat API reachable and budget readable; no VM was started by this probe."
        : "boat environment probe found problems; no VM was started by this probe.",
      diagnostics,
      metadata: {
        provider: "boat",
        size: config.size,
        autoStopMinutes: config.autoStopMinutes,
        budget: budget ?? null,
      },
    };
  }

  // ------------------------------------------------------------- templates

  async captureTemplate(params: PluginEnvironmentCaptureTemplateParams): Promise<PluginEnvironmentCaptureTemplateResult> {
    if (!params.providerLeaseId) throw new BoatProviderError("BOAT_NO_LEASE", "cannot capture a boat template without a sandbox lease.");
    const sandboxId = params.providerLeaseId;
    const config = parseDriverConfig(params.config);
    this.rememberConfig(params.companyId, params.environmentId, config);
    // Under the card lock, so no acquire or release of the card runs between the scrub and the save.
    return await this.withCardLock(params.companyId, sandboxId, null, () => this.captureTemplateLocked(params, sandboxId, config));
  }

  private async captureTemplateLocked(
    params: PluginEnvironmentCaptureTemplateParams,
    sandboxId: string,
    config: BoatDriverConfig,
  ): Promise<PluginEnvironmentCaptureTemplateResult> {
    const api = this.opsApi(config);
    const name = sanitizeSnapshotName(params.templateLabel, `${config.namePrefix}-tpl-${params.environmentId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}-${this.now().toString(36)}`);
    const list = (await api.listNamedSnapshots()) as {
      snapshots?: Array<{ name?: string }>;
      allowance?: { free?: number; used?: number };
    };
    const exists = (list.snapshots ?? []).some((entry) => entry.name === name);
    const free = list.allowance?.free ?? 10;
    const used = list.allowance?.used ?? (list.snapshots ?? []).length;
    if (!exists && used >= free && !config.allowPaidNamedSnapshots) {
      throw new BoatProviderError(
        "BOAT_NAMED_SNAPSHOT_NOT_FREE",
        `all ${free} free boat named snapshots are used; one more costs $1.70 a month. Delete an old template, or set allowPaidNamedSnapshots.`,
      );
    }
    // A named snapshot outlives every run and seeds new VMs, so it must never
    // hold the run JWT in Paperclip's MCP config: remove it first, and refuse
    // the capture when that cannot be verified. A stopped VM is resumed for it
    // (budget-guarded, as for a command): its disk may come from an auto-stop
    // that nobody scrubbed.
    let session: SshSession;
    try {
      session = await this.liveSession(config, params.companyId, sandboxId);
    } catch (error) {
      throw new BoatProviderError(
        "BOAT_RUNTIME_SCRUB_FAILED",
        `could not reach boat VM ${sandboxId} to remove Paperclip's run MCP config (run JWT) before the template capture, so nothing was captured: ${errorText(error)}`,
      );
    }
    const record = await this.store
      .read(params.companyId)
      .then((doc) => findBySandboxId(doc, sandboxId))
      .catch(() => null);
    const scrub = await this.scrubRuntimeSecrets({
      api,
      config,
      sandboxId,
      roots: this.runtimeRoots(config, sandboxId, null, record),
      before: "template capture",
      connect: false,
      session,
    });
    if (scrub.status !== "clean" && scrub.status !== "scrubbed") {
      throw new BoatProviderError(
        "BOAT_RUNTIME_SCRUB_FAILED",
        `could not verify that Paperclip's run MCP config (run JWT) is gone from boat VM ${sandboxId}, so no template was captured (${scrub.status}${scrub.detail ? `: ${scrub.detail}` : ""}).`,
      );
    }
    await api.saveNamedSnapshot({ sandboxId, name });
    const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : config.timeoutMs;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const info = (await api.getNamedSnapshot({ name })) as { snapshot?: { status?: string; error?: string; sizeBytes?: number; snapshotId?: string } };
      const status = info.snapshot?.status;
      if (status === "ready") {
        return {
          templateRef: name,
          templateKind: "snapshot",
          metadata: {
            provider: "boat",
            sandboxId,
            snapshotId: info.snapshot?.snapshotId ?? null,
            sizeBytes: info.snapshot?.sizeBytes ?? null,
            capturedAt: this.nowIso(),
          },
        };
      }
      if (status === "failed") {
        throw new BoatProviderError("BOAT_SNAPSHOT_FAILED", `boat could not save named snapshot ${name}: ${info.snapshot?.error ?? "unknown error"}`);
      }
      if (this.now() >= deadline) {
        throw new BoatProviderError("BOAT_SNAPSHOT_TIMEOUT", `named snapshot ${name} was still saving after ${Math.round(timeoutMs / 1000)} s.`);
      }
      await this.sleep(5000);
    }
  }

  async deleteTemplate(params: PluginEnvironmentDeleteTemplateParams): Promise<PluginEnvironmentDeleteTemplateResult> {
    const kind = params.templateKind ?? "snapshot";
    if (kind !== "snapshot") throw new BoatProviderError("BOAT_TEMPLATE_KIND", `boat templates are named snapshots, not ${kind}.`);
    const config = parseDriverConfig(params.config);
    try {
      await this.opsApi(config).deleteNamedSnapshot({ name: params.templateRef });
      return { deleted: true, metadata: { provider: "boat", reason: params.reason ?? null } };
    } catch (error) {
      const info = await describeBoatError(error);
      if (info.status === 404) return { deleted: false, metadata: { provider: "boat", missing: true } };
      throw new BoatProviderError("BOAT_DELETE_FAILED", `boat could not delete named snapshot ${params.templateRef}: ${formatBoatError(info)}`);
    }
  }

  // ----------------------------------------------------------------- sweep

  /**
   * Stops our VMs that idle (no command in flight, no active lease, last
   * activity older than idleStopMinutes; or an active lease untouched for
   * staleLeaseMinutes) and deletes stopped VMs whose card is done/cancelled or
   * untouched for deleteAfterDays. Uses the configs seen in this worker; with
   * none seen yet it does nothing (boat's auto-stop deadline stays the backstop).
   * Every stop and delete runs under the card lock (an orphan's: the name
   * lock) and re-checks first. While a company's state cannot be read, a VM
   * with no record may be that company's, so it is left alone.
   */
  async sweep(reason: string, options: { force?: boolean } = {}): Promise<SweepReport> {
    if (this.sweeping) return this.sweeping;
    if (!options.force && this.now() - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) {
      return { skipped: "recent", stopped: [], deleted: [], forgotten: [], errors: [] };
    }
    this.sweeping = this.doSweep(reason).finally(() => {
      this.lastSweepAt = this.now();
      this.sweeping = null;
    });
    return this.sweeping;
  }

  /**
   * Fire-and-forget sweep after lifecycle calls (throttled). It outlives the
   * host request that started it, so it runs outside that request's
   * invocation (proactive.ts).
   */
  sweepSoon(reason: string): void {
    if (this.now() - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
    void runOutsideInvocation(() => this.sweep(reason)).catch((error) =>
      this.logger.warn("boat: sweep failed", { error: errorText(error) }),
    );
  }

  /** Test hook: the sweep in flight, if any. */
  sweepInFlight(): Promise<SweepReport> | null {
    return this.sweeping;
  }

  /** The lock the sweep holds to stop or delete a VM: its card's, or for an orphan, its name's (acquire holds both). */
  private withSweepLock<T>(companyId: string, sandbox: SandboxView, record: VmRecord | null, fn: () => Promise<T>): Promise<T> {
    if (record) return this.withLock(this.cardLockKey(companyId, record.key.split("~")[0]), fn);
    return sandbox.name ? this.withLock(this.nameLockKey(sandbox.name), fn) : fn();
  }

  /**
   * Under the sweep lock, right before a delete: is the VM still what the
   * sweep decided on? boat still shows it stopped and unchanged since the
   * listing; this worker ran nothing on it since; its record (if it had one) is
   * unchanged and no run holds it; an orphan still has no record in any company.
   */
  private async stillDeletable(input: {
    api: BoatApiLike;
    sandbox: SandboxView;
    record: VmRecord | null;
    companyId: string;
    docs: Map<string, StateDoc>;
    seenActivity: number;
  }): Promise<boolean> {
    const { sandbox, record } = input;
    const now = await this.getSandbox(input.api, sandbox.id);
    if (!now || now.state !== sandbox.state || now.updatedAt !== sandbox.updatedAt || UP_STATES.has(now.state) || now.state === "archiving") return false;
    if ((this.inflight.get(sandbox.id) ?? 0) > 0 || (this.lastActivity.get(sandbox.id) ?? 0) !== input.seenActivity) return false;
    if (record) {
      const fresh = findBySandboxId(await this.store.read(input.companyId), sandbox.id);
      return (
        !!fresh &&
        fresh.status === record.status &&
        fresh.key === record.key &&
        fresh.starts === record.starts &&
        fresh.lastStartedAt === record.lastStartedAt &&
        fresh.lastActivityAt === record.lastActivityAt &&
        !runHoldsVm(fresh)
      );
    }
    for (const companyId of input.docs.keys()) {
      const doc = await this.store.read(companyId).catch(() => null);
      const owned = doc ? findBySandboxId(doc, sandbox.id) : null;
      if (!doc || (owned && owned.status !== "deleted")) return false;
    }
    return true;
  }

  private async doSweep(reason: string): Promise<SweepReport> {
    const report: SweepReport = { skipped: null, stopped: [], deleted: [], forgotten: [], errors: [] };
    if (this.configs.size === 0) {
      report.skipped = "no_config_seen";
      return report;
    }
    // Which companies own VMs, and their records. A company whose state cannot
    // be read (the host refuses state outside a configured company, see
    // proactive.ts, or the store fails) is skipped, and its VMs' ownership is
    // unknown, not absent: they must not be taken for orphans.
    let companiesKnown = true;
    const remembered = await this.store.companies().catch(() => {
      companiesKnown = false;
      return [] as string[];
    });
    const companies = new Set<string>([...remembered, ...[...this.configs.values()].map((c) => c.companyId)]);
    const docs = new Map<string, StateDoc>();
    const unreadable = new Set<string>();
    for (const companyId of companies) {
      try {
        docs.set(companyId, await this.store.read(companyId));
      } catch (error) {
        unreadable.add(companyId);
        report.errors.push(`state ${companyId}: ${errorText(error)}`);
      }
    }
    if (!companiesKnown) report.errors.push("state: the list of companies could not be read");
    /** Could a company whose state is unknown own VMs of this account? (No cached config for it: it could own any.) */
    const ownershipUnknown = (cachedList: CachedConfig[]): boolean =>
      !companiesKnown ||
      [...unreadable].some((companyId) => {
        const own = [...this.configs.values()].filter((cached) => cached.companyId === companyId);
        return own.length === 0 || own.some((cached) => cachedList.includes(cached));
      });
    const recordFor = (sandboxId: string): VmRecord | null => {
      for (const doc of docs.values()) {
        const record = findBySandboxId(doc, sandboxId);
        if (record && record.status !== "deleted") return record;
      }
      return null;
    };

    const accounts = new Map<string, CachedConfig[]>();
    for (const cached of this.configs.values()) {
      let accountKey: string;
      try {
        accountKey = `${cached.config.apiBase}\u0000${resolveApiKey(cached.config)}`;
      } catch {
        continue;
      }
      accounts.set(accountKey, [...(accounts.get(accountKey) ?? []), cached]);
    }

    const now = this.now();
    for (const cachedList of accounts.values()) {
      const primary = cachedList[0];
      const prefixes = new Set(cachedList.map((c) => c.config.namePrefix));
      const namePattern = new RegExp(`^(${[...prefixes].map((p) => p.replace(/[^a-z0-9-]/g, "")).join("|")})-[0-9a-f]{16}$`);
      let sandboxes: SandboxView[];
      try {
        sandboxes = await this.listSandboxes(this.opsApi(primary.config));
      } catch (error) {
        report.errors.push(`list: ${errorText(error)}`);
        continue;
      }
      const seen = new Set(sandboxes.map((s) => s.id));
      const unknownOwner = ownershipUnknown(cachedList);
      const leftAlone: string[] = [];
      for (const sandbox of sandboxes) {
        const record = recordFor(sandbox.id);
        if (!record && !(sandbox.name && namePattern.test(sandbox.name))) continue; // not ours
        if (!record && unknownOwner) {
          // Maybe an orphan, maybe a VM of the company whose state could not be read (with an active lease): leave it.
          leftAlone.push(sandbox.id);
          continue;
        }
        const config = (record && this.configs.get(record.environmentId)?.config) || primary.config;
        const api = this.opsApi(config);
        const companyId = record?.companyId ?? primary.companyId;
        try {
          if (UP_STATES.has(sandbox.state)) {
            if ((this.inflight.get(sandbox.id) ?? 0) > 0) continue;
            const lastActivity = Math.max(
              this.lastActivity.get(sandbox.id) ?? 0,
              await this.store.activityAt(companyId, sandbox.id),
              Date.parse(record?.lastActivityAt ?? "") || 0,
              Date.parse(record?.lastStartedAt ?? "") || 0,
              record ? 0 : Date.parse(sandbox.updatedAt ?? sandbox.createdAt ?? "") || 0,
            );
            const idleMinutes = (now - lastActivity) / 60_000;
            const hasActive = (record?.activeRunIds.length ?? 0) > 0;
            // A release already asked for the stop but the VM is still up (the
            // stop had not taken effect yet): confirm it now, without waiting
            // for the idle thresholds.
            const confirmingRelease = record?.status === "stopping";
            const shouldStop = confirmingRelease || (hasActive ? idleMinutes > config.staleLeaseMinutes : idleMinutes > config.idleStopMinutes);
            if (!shouldStop) continue;
            // Stop under the card lock (an orphan: the name lock), so a run that is acquiring this VM right now
            // finishes first; then re-check, because that run may have taken it.
            const outcome = await this.withSweepLock(companyId, sandbox, record, async () => {
              let held = false;
              if (record) {
                const fresh = findBySandboxId(await this.store.read(companyId), sandbox.id);
                if (confirmingRelease && fresh?.status !== "stopping") return null;
                const freshActivity = Math.max(
                  this.lastActivity.get(sandbox.id) ?? 0,
                  await this.store.activityAt(companyId, sandbox.id),
                  Date.parse(fresh?.lastActivityAt ?? "") || 0,
                );
                if ((this.inflight.get(sandbox.id) ?? 0) > 0 || freshActivity > lastActivity) return null;
                if ((fresh?.activeRunIds.length ?? 0) > (record.activeRunIds.length ?? 0)) return null;
                held = runHoldsVm(fresh ?? record);
              } else {
                // An orphan: a run (in this worker, or one that wrote a record) may have adopted it by name meanwhile.
                if ((this.inflight.get(sandbox.id) ?? 0) > 0 || (this.lastActivity.get(sandbox.id) ?? 0) > lastActivity) return null;
                for (const owner of docs.keys()) {
                  const doc = await this.store.read(owner).catch(() => null);
                  const adopted = doc ? findBySandboxId(doc, sandbox.id) : null;
                  if (!doc || (adopted && adopted.status !== "deleted")) return null;
                }
              }
              // Same as release: the stop snapshot must not keep the run JWT,
              // so a VM whose scrub fails is deleted instead of stopped. Except
              // a VM that a run still holds (a stale lease, or a resumed lease):
              // its work is not synced back yet, so it is stopped, disk kept;
              // and an incomplete scrub (nothing found, part of the disk
              // unsearchable), which is stopped with its disk kept too.
              const scrub = await this.scrubRuntimeSecrets({
                api,
                config,
                sandboxId: sandbox.id,
                roots: this.runtimeRoots(config, sandbox.id, null, record),
                before: "stop",
                connect: true,
              });
              await this.ssh.closeSession(sandbox.id);
              this.clearExtendTimer(sandbox.id);
              if (scrubUnverified(scrub)) {
                const reason = unverifiedScrubReason(scrub);
                if (held || scrub.status === "incomplete") {
                  this.logKeptDisk({ sandboxId: sandbox.id, trigger: "sweep", keep: held ? "held_lease" : "incomplete_scan", reason });
                } else if (await this.deleteInsteadOfStop({ api, config, companyId, sandboxId: sandbox.id, runId: null, trigger: "sweep", reason })) {
                  return "deleted" as const;
                }
              }
              const confirmed = await this.stopAndConfirm(api, sandbox.id, config.stopConfirmTimeoutMs);
              if (record) {
                await this.store.update(companyId, (doc) => {
                  const current = findBySandboxId(doc, sandbox.id);
                  if (!current) return;
                  current.status = confirmed ? "stopped" : "stopping";
                  current.lastStoppedAt = this.nowIso();
                  current.activeRunIds = [];
                });
                await this.recordStopUsage(config, companyId, sandbox.id, null).catch(() => undefined);
              }
              return "stopped" as const;
            });
            if (!outcome) continue;
            if (outcome === "deleted") {
              report.deleted.push(sandbox.id);
              this.logger.info("boat: sweep deleted an idle VM instead of stopping it (runtime_scrub_failed)", { sandboxId: sandbox.id, orphan: !record, reason });
              continue;
            }
            report.stopped.push(sandbox.id);
            this.logger.info(`boat: sweep stopped an idle VM after ${Math.round(idleMinutes)} min`, {
              sandboxId: sandbox.id,
              hadActiveLease: hasActive,
              orphan: !record,
              reason,
            });
            continue;
          }
          if (sandbox.state === "archiving") continue;
          // Stopped (archived), error or cancelled: costs nothing; delete when the card is finished or old.
          // A release that returned on stop-accept leaves the record stopping;
          // the first sweep that sees the save confirmed flips it to stopped.
          if (record?.status === "stopping") {
            await this.withSweepLock(companyId, sandbox, record, async () => {
              // The listing may predate a successor run. Re-read boat under the
              // card lock, and keep that lock through the usage ledger closure.
              const live = await this.getSandbox(api, sandbox.id);
              if (!live || UP_STATES.has(live.state) || live.state === "archiving") return;
              const flipped = await this.store.update(companyId, (doc) => {
                const current = findBySandboxId(doc, sandbox.id);
                if (!current || current.status !== "stopping" || current.lastStoppedAt !== record.lastStoppedAt || current.starts !== record.starts) return false;
                current.status = "stopped";
                current.activeRunIds = [];
                return true;
              });
              if (!flipped) return;
              await this.recordStopUsage(config, companyId, sandbox.id, null).catch(() => undefined);
              this.logger.info("boat: sweep confirmed a release stop", { sandboxId: sandbox.id, reason });
            });
          }
          const seenActivity = this.lastActivity.get(sandbox.id) ?? 0;
          let deleteReason: string | null = null;
          if (sandbox.dataExpiredAt) deleteReason = "disk_expired";
          if (!deleteReason && record?.issueId && this.issues) {
            const issue = await this.issues.get(record.issueId, record.companyId).catch(() => undefined);
            if (issue && DONE_ISSUE_STATUSES.has(String(issue.status ?? ""))) deleteReason = `card_${issue.status}`;
          }
          if (!deleteReason) {
            const last = Math.max(
              Date.parse(record?.lastActivityAt ?? "") || 0,
              Date.parse(record?.lastStoppedAt ?? "") || 0,
              Date.parse(sandbox.updatedAt ?? sandbox.createdAt ?? "") || 0,
            );
            if (last > 0 && now - last > config.deleteAfterDays * 24 * 3600 * 1000) deleteReason = "untouched";
          }
          if (!deleteReason) continue;
          // Everything above was read before awaits (the issue lookup) in which a run may have
          // resumed the card. Delete only under the card lock (an orphan: the name lock), and only
          // when boat, plugin state and this worker still show the same stopped, unheld VM.
          const deleted = await this.withSweepLock(companyId, sandbox, record, async () => {
            if (!(await this.stillDeletable({ api, sandbox, record, companyId, docs, seenActivity }))) return false;
            if (record) await this.recordStopUsage(config, companyId, sandbox.id, null).catch(() => undefined);
            await this.deleteSandbox(api, sandbox.id);
            if (record) await this.markDeleted(companyId, sandbox.id);
            return true;
          });
          if (!deleted) {
            this.logger.info("boat: sweep left a stopped VM alone: it changed while the sweep decided to delete it", { sandboxId: sandbox.id, deleteReason, reason });
            continue;
          }
          report.deleted.push(sandbox.id);
          this.logger.info(`boat: sweep deleted a stopped VM (${deleteReason})`, { sandboxId: sandbox.id, reason });
        } catch (error) {
          report.errors.push(`${sandbox.id}: ${errorText(error)}`);
        }
      }
      if (leftAlone.length > 0) {
        this.logger.warn("boat: sweep left VMs alone whose owner is unknown while a company's plugin state cannot be read", { sandboxIds: leftAlone });
      }
      // Records whose VM no longer exists at boat: forget them.
      for (const [companyId, doc] of docs) {
        for (const record of Object.values(doc.vms)) {
          if (record.status === "deleted" || seen.has(record.sandboxId)) continue;
          const owner = this.configs.get(record.environmentId);
          if (!owner || !cachedList.includes(owner)) continue;
          await this.markDeleted(companyId, record.sandboxId).catch(() => undefined);
          report.forgotten.push(record.sandboxId);
        }
      }
    }
    return report;
  }

  // ----------------------------------------------------------------- usage

  async usageSummary(companyId: string, options: { refresh?: boolean } = {}): Promise<UsageSummary> {
    let doc = await this.store.read(companyId);
    if (options.refresh) {
      // boat's meter can lag a stop by a little, so re-read lifetimes and any
      // run window that was read within 10 minutes of its end.
      const refreshed: Array<[string, UsageReading]> = [];
      const sessionReadings: Array<[string, string, string, UsageReading]> = [];
      let budgetCalls = 100;
      for (const record of Object.values(doc.vms).slice(0, 50)) {
        if (record.status === "deleted" || budgetCalls <= 0) continue;
        const cached = this.configs.get(record.environmentId);
        if (!cached) continue;
        const reading = await this.readUsage(cached.config, record.sandboxId, {}, record.size);
        budgetCalls -= 1;
        if (reading.source === "boat") refreshed.push([record.sandboxId, reading]);
        for (const entry of record.sessions) {
          if (!entry.endedAt || budgetCalls <= 0) continue;
          const ended = Date.parse(entry.endedAt);
          const readAt = entry.usage ? Date.parse(entry.usage.at) : 0;
          if (entry.usage?.source === "boat" && readAt - ended >= 10 * 60 * 1000) continue;
          if (this.now() - ended < 2 * 60 * 1000) continue;
          const windowReading = await this.readUsage(cached.config, record.sandboxId, { since: entry.startedAt, until: entry.endedAt }, entry.size);
          budgetCalls -= 1;
          if (windowReading.source === "boat") sessionReadings.push([record.sandboxId, entry.runId, entry.startedAt, windowReading]);
        }
      }
      if (refreshed.length > 0 || sessionReadings.length > 0) {
        await this.store.update(companyId, (state) => {
          for (const [sandboxId, reading] of refreshed) {
            const record = findBySandboxId(state, sandboxId);
            if (record) record.lifetimeUsage = reading;
          }
          for (const [sandboxId, runId, startedAt, reading] of sessionReadings) {
            const entry = findBySandboxId(state, sandboxId)?.sessions.find((item) => item.runId === runId && item.startedAt === startedAt);
            if (entry) entry.usage = reading;
          }
        });
        doc = await this.store.read(companyId);
      }
    }
    const vms = Object.values(doc.vms).map((record) => {
      const runs = record.sessions.map((entry) => ({
        runId: entry.runId,
        agentId: entry.agentId,
        startKind: entry.startKind,
        size: entry.size,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        seconds: entry.usage?.seconds ?? null,
        dollars: entry.usage?.dollars ?? null,
        source: entry.usage?.source ?? null,
      }));
      const runSeconds = runs.reduce((sum, run) => sum + (run.seconds ?? 0), 0);
      const runDollars = runs.reduce((sum, run) => sum + (run.dollars ?? 0), 0);
      // Lifetime from boat's meter when we have it; it also counts idle tails between runs.
      const seconds = record.lifetimeUsage?.seconds ?? runSeconds;
      const dollars = record.lifetimeUsage?.dollars ?? runDollars;
      return {
        vmKey: record.key.split("~")[0],
        sandboxId: record.sandboxId,
        sandboxName: record.name,
        issueId: record.issueId,
        executionWorkspaceId: record.executionWorkspaceId,
        status: record.status,
        size: record.size,
        starts: record.starts,
        createdAt: record.createdAt,
        lastStoppedAt: record.lastStoppedAt,
        seconds,
        dollars,
        source: record.lifetimeUsage ? record.lifetimeUsage.source : runs.length ? "runs" : null,
        runs,
      };
    });
    const cards = new Map<string, { issueId: string | null; vmKey: string; seconds: number; dollars: number; vms: number; runs: number }>();
    for (const vm of vms) {
      const cardKey = vm.issueId ?? vm.vmKey;
      const entry = cards.get(cardKey) ?? { issueId: vm.issueId, vmKey: vm.vmKey, seconds: 0, dollars: 0, vms: 0, runs: 0 };
      entry.seconds += vm.seconds;
      entry.dollars += vm.dollars;
      entry.vms += 1;
      entry.runs += vm.runs.length;
      cards.set(cardKey, entry);
    }
    return {
      companyId,
      generatedAt: this.nowIso(),
      note: "seconds are boat billable machine time (size already applied); dollars are list price. Per-run figures cover each run's lease window.",
      totals: {
        seconds: vms.reduce((sum, vm) => sum + vm.seconds, 0),
        dollars: Number(vms.reduce((sum, vm) => sum + vm.dollars, 0).toFixed(6)),
        vms: vms.length,
        runs: vms.reduce((sum, vm) => sum + vm.runs.length, 0),
        running: vms.filter((vm) => vm.status === "running" || vm.status === "starting").length,
      },
      budget: this.lastBudget,
      cards: [...cards.values()].sort((a, b) => b.dollars - a.dollars),
      vms,
    };
  }

  health(): Record<string, unknown> {
    return {
      configsSeen: this.configs.size,
      sshSessions: this.ssh.listSessions().map((session) => ({ sandboxId: session.sandboxId, tunnel: session.tunnel })),
      commandsInFlight: [...this.inflight.values()].reduce((sum, value) => sum + value, 0),
      lastSweepAt: this.lastSweepAt ? new Date(this.lastSweepAt).toISOString() : null,
      lastBudgetAt: this.lastBudget?.at ?? null,
    };
  }

  async shutdown(): Promise<void> {
    for (const sandboxId of [...this.extendTimers.keys()]) this.clearExtendTimer(sandboxId);
    await this.ssh.closeAll();
  }
}

export interface SweepReport {
  skipped: string | null;
  stopped: string[];
  deleted: string[];
  forgotten: string[];
  errors: string[];
}

export interface UsageSummary {
  companyId: string;
  generatedAt: string;
  note: string;
  totals: { seconds: number; dollars: number; vms: number; runs: number; running: number };
  budget: { snapshot: BudgetSnapshot; at: string } | null;
  cards: Array<{ issueId: string | null; vmKey: string; seconds: number; dollars: number; vms: number; runs: number }>;
  vms: Array<Record<string, unknown> & { runs: unknown[] }>;
}

export function sanitizeSnapshotName(label: string | null | undefined, fallback: string): string {
  const cleaned = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

async function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
