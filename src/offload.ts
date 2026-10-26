// v1 offload executor: one heavy command on a shared pool VM.
// Design: docs/adr/0001-heavy-command-offload.md.
//
// Scope: warm pick, resume/create up to maxOffloadVms, FIFO queue, idle stop
// after C with generation-guarded timers, start/compute budget fallback to
// OFFLOAD_UNAVAILABLE, per-command usage + expected-cost log, idempotency by
// commandId. Durable journal/receipt recovery and account admission are both
// wired here. Guest lifecycle and incremental output are opt-in; persisted
// pool recovery is opt-in too; HTTP routing and real sync adapters remain separate.
import { createHash } from "node:crypto";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { PRICE_PER_HOUR } from "./size-policy.js";
import { describeBoatError } from "./errors.js";
import { AccountLedger, definitiveStartRejection } from "./account-ledger.js";
import type { AccountReservation, AccountUsageRow } from "./account-ledger.js";
import { OffloadJournal, commandDigest, commandKey, type OffloadDurableDeps, type OffloadIdentity } from "./offload-journal.js";
import type { StateClientLike } from "./state.js";
import { OffloadPoolStore, type PoolVm } from "./offload-pool.js";
import { OffloadLifecycle, type CommandExit, type ExecutionIdentity, type GuestController, type OffloadRunContext } from "./offload-lifecycle.js";
export type { GuestIdentity, GuestController, OffloadRunContext } from "./offload-lifecycle.js";
export { OffloadGuestRunner } from "./offload-guest.js";
export type { OffloadStore, OffloadIdentity, OffloadRecord, OffloadCommandView, OffloadReadView,
  OffloadOutputEvent, OffloadDurableDeps } from "./offload-journal.js";

export interface OffloadCommand {
  commandId: string;
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  /** Defaults to cargo; the route layer fills it before submit. */
  tool?: "cargo" | "node" | "python";
  /** Package runner / test binary; the route layer fills the default. */
  runner?: string;
  /** Guest executable; defaults to the runner, then cargo. */
  executable?: string;
  argv: string[];
  executionWorkspaceId?: string;
  trustDomainId?: string;
  cwdRelative?: string;
  env?: Record<string, string>;
  queueTimeoutMs?: number;
  timeoutMs?: number;
}

export type OffloadWarm = "warm" | "cold";

// Returned changes are staged for explicit review, never applied to live files.
export interface OffloadSyncBack {
  state: "clean" | "staged" | "conflict";
  changedPaths: string[];
  conflictPaths: string[];
  artifactId: string | null;
}

export type OffloadResult =
  | {
      status: "completed";
      commandId: string;
      sandboxId: string;
      warm: OffloadWarm;
      queueWaitMs: number;
      exitCode: number;
      seconds: number;
      dollars: number;
      remoteStarted?: true;
      fallbackSafe?: false;
      cancelled?: boolean;
      timedOut?: boolean;
      syncBack?: OffloadSyncBack;
    }
  | {
      status: "unknown";
      code: "OFFLOAD_UNKNOWN";
      commandId: string;
      sandboxId: string;
      warm: OffloadWarm;
      queueWaitMs: number;
      // Conservative: execution may have started. This is never a replay receipt.
      remoteStarted: true;
      fallbackSafe: false;
      exitCode: 75;
      seconds: number;
      dollars: number;
      reason: string;
    }
  | {
      status: "unavailable";
      code: "OFFLOAD_UNAVAILABLE";
      commandId: string;
      remoteStarted: false;
      fallbackSafe: true;
      reason: string;
    };

export type OffloadUsageRow = AccountUsageRow;

export interface OffloadExecutorConfig {
  maxOffloadVms: number;
  offloadIdleStopSeconds: number;
  queueLimit?: number;
  queueTimeoutMs?: number;
  size?: BoatSize;
  maxActive?: number;
  maxStartsPerDay?: number;
  minComputeHoursLeft?: number;
  /** Monthly cap on tracked offload VM-hours; 0 disables the extra cap. */
  offloadMonthlyVmHourCap?: number;
  /** Named boat snapshot new pool VMs boot from (driver `templateSnapshot`); null = stock image. */
  templateSnapshot?: string | null;
}

export interface OffloadTimers {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface OffloadLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface OffloadDeps extends Partial<OffloadDurableDeps> {
  state: StateClientLike;
  // Stable, credential-free provider identity, shared with the whole-run manager.
  accountId: string;
  poolId: string;
  boat: BoatApiLike;
  logger: OffloadLogger;
  now: () => number;
  timers?: OffloadTimers;
  config: OffloadExecutorConfig;
  guest?: undefined;
  runCommand: (sandboxId: string, command: OffloadCommand, identity?: OffloadIdentity) => Promise<CommandExit>;
  /**
   * Telemetry hook: completed remote command durations feed the duration
   * gate. Failures must be swallowed by the implementation; a learning write
   * never fails a command.
   */
  recordDuration?: (command: OffloadCommand, seconds: number) => Promise<void> | void;
}

// A separate transport shape keeps the landed identity-only runner compatible.
// Lifecycle-enabled callers must supply the complete durable journal ports.
export interface OffloadLifecycleDeps extends Omit<OffloadDeps, "guest" | "runCommand" | keyof OffloadDurableDeps>, OffloadDurableDeps {
  guest: GuestController;
  runCommand(sandboxId: string, command: OffloadCommand, context?: OffloadRunContext): Promise<CommandExit>;
}

type Reservation = { kind: "run"; vm: PoolVm; warm: OffloadWarm };
type Dispatch = Reservation | OffloadResult;
type Slot = Reservation | { kind: "unavailable"; reason: string } | { kind: "blocked" };
type Claim = Exclude<Slot, { kind: "blocked" }> | { kind: "queued"; wait: Promise<Dispatch> };

interface Queued {
  command: OffloadCommand;
  resolve: (result: Dispatch) => void;
  reject: (error: unknown) => void;
  timerHandle: unknown | null;
  refusal: Promise<void> | null;
}

function digestOf(command: OffloadCommand): string {
  // Internal payload identity; never included in logs or usage.
  return JSON.stringify({ repoId: command.repoId, profileId: command.profileId,
    tool: command.tool ?? "cargo", runner: command.runner ?? "cargo", argv: command.argv });
}

function sandboxIdOf(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;
  const sandbox = root.sandbox as Record<string, unknown> | undefined;
  const id = sandbox?.id ?? root.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function sandboxStateOf(response: unknown, sandboxId: string): string | null {
  if (!response || typeof response !== "object") return null;
  const root = response as { ok?: unknown; sandbox?: { id?: unknown; state?: unknown } };
  return root.ok === true && root.sandbox?.id === sandboxId && typeof root.sandbox.state === "string"
    ? root.sandbox.state : null;
}

const DEFAULTS = {
  queueLimit: 32,
  queueTimeoutMs: 30_000,
  size: "default" as BoatSize,
  maxActive: 2,
  maxStartsPerDay: 70,
  minComputeHoursLeft: 1,
};

export class OffloadExecutor {
  private readonly boat: BoatApiLike;
  private readonly ledger: AccountLedger;
  private readonly poolId: string;
  private readonly logger: OffloadLogger;
  private readonly now: () => number;
  private readonly timers: OffloadTimers;
  private readonly config: Required<Pick<OffloadExecutorConfig, "maxOffloadVms" | "offloadIdleStopSeconds">> &
    Required<Pick<OffloadExecutorConfig, "queueLimit" | "queueTimeoutMs" | "size" | "maxActive" | "maxStartsPerDay" | "minComputeHoursLeft">> &
    Pick<OffloadExecutorConfig, "offloadMonthlyVmHourCap" | "templateSnapshot">;
  private readonly runCommand: (...args: Parameters<OffloadDeps["runCommand"]>) =>
    Promise<CommandExit & { syncBack?: OffloadSyncBack }>;
  private readonly recordDuration?: OffloadDeps["recordDuration"];
  private readonly durable: OffloadJournal | null;
  private readonly lifecycle: OffloadLifecycle | null;
  private readonly pool: PoolVm[] = [];
  private readonly poolStore: OffloadPoolStore | null;
  private poolStartup: Promise<void> | null = null;
  private readonly queue: Queued[] = [];
  private readonly journal = new Map<string, { digest: string; result: OffloadResult | null }>();
  private readonly inFlight = new Map<string, Promise<OffloadResult>>();
  private readonly stopFailures = new Set<string>();
  private readonly knownCommands = new Map<string, OffloadCommand | null>();
  private admission: Promise<unknown> = Promise.resolve();
  private closed = false;
  private shutdownTask: Promise<void> | null = null;

  constructor(deps: OffloadDeps | OffloadLifecycleDeps) {
    this.boat = deps.boat;
    this.logger = deps.logger;
    this.now = deps.now;
    this.timers = deps.timers ?? { set: (cb, ms) => setTimeout(cb, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.config = {
      maxOffloadVms: deps.config.maxOffloadVms,
      offloadIdleStopSeconds: deps.config.offloadIdleStopSeconds,
      queueLimit: deps.config.queueLimit ?? DEFAULTS.queueLimit,
      queueTimeoutMs: deps.config.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs,
      size: deps.config.size ?? DEFAULTS.size,
      maxActive: deps.config.maxActive ?? DEFAULTS.maxActive,
      maxStartsPerDay: deps.config.maxStartsPerDay ?? DEFAULTS.maxStartsPerDay,
      minComputeHoursLeft: deps.config.minComputeHoursLeft ?? DEFAULTS.minComputeHoursLeft,
      offloadMonthlyVmHourCap: deps.config.offloadMonthlyVmHourCap ?? 0,
      templateSnapshot: deps.config.templateSnapshot ?? null,
    };
    const hasDurableDeps = deps.guest || deps.journalStore || deps.guestReceipts || deps.resolveRunState || deps.sync;
    if (hasDurableDeps && !(deps.journalStore && deps.guestReceipts && deps.resolveRunState && deps.sync)) {
      throw new Error("OFFLOAD_DURABLE_CONFIGURATION_REQUIRED");
    }
    this.lifecycle = deps.guest ? new OffloadLifecycle(deps.guest, this.now, this.timers) : null;
    this.durable = hasDurableDeps ? new OffloadJournal(deps as OffloadDurableDeps, this.now, {
      hold: (identity, command) => this.restoreHold(identity, command),
      release: (identity) => this.releaseHold(identity),
      bind: (identity) => this.bindIdentity(identity),
      cancel: (command, result) => this.cancelQueued(command, result),
    }, this.lifecycle ?? undefined) : null;
    const transport: OffloadDeps["runCommand"] = deps.guest
      ? (_vm, command, identity) => this.lifecycle!.run(identity as ExecutionIdentity, command, deps.runCommand,
        (stream, bytes) => this.requireDurable().appendOutput(command, stream, bytes))
      : deps.runCommand;
    this.runCommand = this.durable
      ? (vm, command) => this.durable!.run(vm, command, transport)
      : transport;
    this.recordDuration = deps.recordDuration;
    if (!(deps.state && deps.accountId && deps.poolId)) throw new Error("account admission requires durable state, accountId and poolId");
    this.poolId = deps.poolId;
    this.ledger = new AccountLedger(deps.state, deps.accountId, this.now);
    this.poolStore = deps.guest ? new OffloadPoolStore(deps.state, deps.accountId, deps.poolId) : null;
  }

  async recover(): Promise<void> {
    await this.recoverPool();
    await this.requireDurable().recover();
  }

  private async recoverPool(): Promise<void> {
    if (!this.poolStore) return;
    if (!this.poolStartup) {
      const task = this.withAdmission(async () => {
        const loaded = await this.poolStore!.load();
        for (const vm of loaded) {
          // An in-flight allocation (including an unknown create ID) or guest
          // reservation cannot become idle just because its worker disappeared.
          if (vm.busy || !vm.sandboxId) { vm.busy = false; vm.quarantined = true; }
          if (!vm.stopped && !vm.stopping && !vm.quarantined) {
            try {
              if (!vm.identity || (await this.lifecycle!.observe(vm.identity)).populated) vm.quarantined = true;
            } catch { vm.quarantined = true; }
          }
        }
        await this.ledger.load();
        this.pool.splice(0, this.pool.length, ...loaded);
      });
      this.poolStartup = task;
      void task.catch(() => { if (this.poolStartup === task) this.poolStartup = null; });
    }
    await this.poolStartup;
  }

  private async persistPool(): Promise<void> { await this.poolStore?.save(this.config, this.pool); }

  private async persistStopTelemetry(vm: PoolVm): Promise<void> {
    if (vm.stopRequestedAt !== null) await this.ledger.stopRequested(vm.sandboxId,
      vm.stopDueAt ?? vm.stopRequestedAt, vm.stopRequestedAt, vm.accountReservation?.id);
    if (vm.stopObservedAt != null) await this.ledger.stopped(vm.sandboxId, vm.stopObservedAt, vm.accountReservation?.id);
  }

  // Returns true only for verified running state, where an idempotent stop can
  // repair a worker crash between persisting intent and actually sending it.
  private async observeStop(vm: PoolVm): Promise<boolean> {
    let state: string | null = null;
    try {
      state = sandboxStateOf(await this.boat.get({ sandboxId: vm.sandboxId }), vm.sandboxId);
    } catch (error) {
      if ((await describeBoatError(error)).status === 404) state = "deleted";
    }
    if (!["archived", "cancelled", "deleted"].includes(state ?? "")) {
      return ["ready", "idle", "running"].includes(state ?? "");
    }
    vm.stopObservedAt ??= this.now();
    try { await this.persistStopTelemetry(vm); }
    catch {
      this.logger.error("boat offload terminal receipt persistence failed; reconcile will converge", { sandboxId: vm.sandboxId });
      // Do not let a new reservation discard still-uncommitted stop evidence.
      return false;
    }
    this.stopFailures.delete(vm.sandboxId);
    if (state === "deleted") {
      this.retireVm(vm);
    } else {
      vm.stopping = false;
      vm.stopped = true;
    }
    return false;
  }

  private async bindIdentity(identity: OffloadIdentity): Promise<void> {
    await this.withAdmission(async () => {
      const vm = this.pool.find((entry) => entry.sandboxId === identity.sandboxId);
      if (!vm) throw new Error("OFFLOAD_POOL_OWNERSHIP_UNKNOWN");
      vm.identity = structuredClone(identity);
      await this.persistPool();
    });
  }

  // Entry point for native plugin sweep-job integration. Never creates a VM, resets an idle
  // deadline, or treats a receipt/leader exit as proof of descendant cleanup.
  async sweep(): Promise<void> {
    await this.recover();
    await this.withAdmission(async () => {
      for (const vm of [...this.pool]) {
        if (vm.busy || vm.quarantined || !vm.sandboxId) continue;
        if (vm.stopping) {
          if (await this.observeStop(vm)) await this.stopVm(vm, true);
        } else if (vm.stopped) {
          await this.persistStopTelemetry(vm);
        } else if (vm.stopDueAt !== null && this.now() >= vm.stopDueAt) {
          this.clearIdleTimer(vm);
          await this.stopVm(vm);
        }
      }
      await this.persistPool();
    });
    await this.reconcile();
  }
  async collectGarbage(): Promise<void> { await this.requireDurable().collectGarbage(); }
  async readCommand(companyId: string, runId: string, commandId: string) {
    return await this.requireDurable().readCommand(companyId, runId, commandId);
  }
  async cancelCommand(companyId: string, runId: string, commandId: string, reason: string, generation?: number) {
    return await this.requireDurable().cancelCommand(companyId, runId, commandId, reason, generation);
  }
  // ID-only convenience calls are restricted to commands admitted by this
  // executor. Ambiguous IDs fail closed; external routes must use scoped calls.
  private knownCommand(commandId: string): OffloadCommand {
    const command = this.knownCommands.get(commandId);
    if (!command) throw new Error("OFFLOAD_COMMAND_SCOPE_REQUIRED");
    return command;
  }
  async cancel(commandId: string, reason: string, generation?: number) {
    const command = this.knownCommand(commandId);
    return await this.cancelCommand(command.companyId, command.runId, commandId, reason, generation);
  }
  async heartbeatCommand(companyId: string, runId: string, commandId: string, generation?: number) {
    return await this.requireDurable().heartbeatCommand(companyId, runId, commandId, generation);
  }
  async heartbeat(commandId: string, generation?: number) {
    const command = this.knownCommand(commandId);
    return await this.heartbeatCommand(command.companyId, command.runId, commandId, generation);
  }
  async readOutput(companyId: string, runId: string, commandId: string, after = 0, limitBytes = 65_536) {
    return await this.requireDurable().readOutput(companyId, runId, commandId, after, limitBytes);
  }
  async read(commandId: string, after = 0, limitBytes = 65_536) {
    const command = this.knownCommand(commandId);
    return await this.readOutput(command.companyId, command.runId, commandId, after, limitBytes);
  }
  async start(command: OffloadCommand) {
    const snapshot = this.trackCommand(command);
    await this.recoverPool();
    const view = await this.requireDurable().start(snapshot, () => this.executeVolatile(snapshot));
    return { ...view, events: [], nextCursor: 0 };
  }
  private requireDurable(): OffloadJournal {
    if (!this.durable) throw new Error("OFFLOAD_DURABLE_CONFIGURATION_REQUIRED");
    return this.durable;
  }

  private async restoreHold(identity: OffloadIdentity, command?: OffloadCommand): Promise<void> {
    await this.withAdmission(async () => {
      let vm = this.pool.find((entry) => entry.sandboxId === identity.sandboxId);
      if (!vm) {
        vm = { sandboxId: identity.sandboxId, busy: false, stopped: false, quarantined: true,
          lastActiveAt: this.now(), generation: identity.journalGeneration, idleHandle: null, stopDueAt: null, stopAttempts: 0,
          stopping: false, stopRequestedAt: null, identity: structuredClone(identity) };
        this.pool.push(vm);
      }
      if (command) {
        vm.workspaceKey = this.workspaceKey(command);
        vm.compatibilityKey ??= this.compatibilityKey(command);
      }
      vm.quarantined = true;
      vm.generation += 1;
      this.clearIdleTimer(vm);
      if (this.lifecycle) {
        try { await this.lifecycle.observe(identity); } catch { /* Hold on missing or mismatched ownership. */ }
      }
      await this.persistPool();
    });
  }

  private async releaseHold(identity: OffloadIdentity): Promise<void> {
    const vm = this.pool.find((entry) => entry.sandboxId === identity.sandboxId);
    if (!vm) return;
    // A verified old result permits capacity again, but not an assumption that
    // the VM survived a restart in running state. Resume under the budget gate.
    await this.withAdmission(async () => {
      vm.quarantined = false;
      vm.busy = false;
      vm.workspaceKey = null;
      vm.stopped = true;
      vm.lastActiveAt = this.now();
      await this.persistPool();
    });
  }

  getUsage(): AccountUsageRow[] {
    return this.ledger.usage(this.poolId);
  }

  async reconcile(): Promise<void> {
    await this.ledger.reconcile(this.boat, undefined, false, false, this.poolId);
  }

  async shutdown(): Promise<void> {
    // Fence synchronously, before waiting for admission or a provider response.
    // Existing IDs still return their real receipt, never a false safe fallback.
    this.closed = true;
    if (this.shutdownTask) return await this.shutdownTask;
    const pending = [...this.inFlight.values(), ...(this.durable?.pending() ?? [])];
    const task = this.drain(pending);
    this.shutdownTask = task;
    try {
      await task;
    } finally {
      this.shutdownTask = null;
    }
  }

  private async drain(pending: Promise<OffloadResult>[]): Promise<void> {
    const refusals = await this.withAdmission(async () => {
      const tasks = this.queue.map((entry) => this.refuseQueued(entry, "executor shutdown"));
      for (const vm of [...this.pool]) {
        this.clearIdleTimer(vm);
        if (vm.busy || vm.quarantined) continue;
        if (vm.stopping) {
          if (await this.observeStop(vm)) await this.stopVm(vm, true);
        } else if (!vm.stopped) await this.stopVm(vm);
      }
      await this.persistPool();
      return tasks;
    });
    await Promise.allSettled(refusals);
    // Do not interrupt a healthy command. Its release stops the VM immediately
    // while closed; no new idle countdown is installed during shutdown.
    await Promise.allSettled(pending);
    if (this.stopFailures.size > 0) {
      throw Object.assign(new Error("OFFLOAD_SHUTDOWN_INCOMPLETE: idle VM stop failed; retry shutdown."), { code: "OFFLOAD_SHUTDOWN_INCOMPLETE" });
    }
    // Unknown commands remain quarantined for receipt reconciliation. Stopping
    // them here would kill a possibly live command; the guest deadline is needed.
  }

  private async withAdmission<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.admission;
    const next = previous.then(fn, fn);
    this.admission = next.catch(() => undefined);
    return await next;
  }

  private trackCommand(command: OffloadCommand): OffloadCommand {
    // Snapshot caller-owned objects before any await; mutating argv or env must
    // never change the payload after its durable digest was accepted.
    const snapshot = structuredClone(command);
    const known = this.knownCommands.get(snapshot.commandId);
    if (!this.knownCommands.has(snapshot.commandId)) this.knownCommands.set(snapshot.commandId, snapshot);
    else if (known && commandKey(known) !== commandKey(snapshot)) this.knownCommands.set(snapshot.commandId, null);
    return snapshot;
  }

  async execute(command: OffloadCommand): Promise<OffloadResult> {
    const snapshot = this.trackCommand(command);
    await this.recoverPool();
    return this.durable ? await this.durable.execute(snapshot, () => this.executeVolatile(snapshot)) : await this.executeVolatile(snapshot);
  }

  private cacheKey(command: OffloadCommand): string {
    // Preserve the legacy unwired cache contract; durable IDs are run-scoped.
    return this.durable ? commandKey(command) : command.commandId;
  }

  private async executeVolatile(command: OffloadCommand): Promise<OffloadResult> {
    const key = this.cacheKey(command);
    const digest = commandDigest(command);
    const seen = this.journal.get(key);
    if (seen) {
      if (seen.digest !== digest) {
        throw Object.assign(new Error(`OFFLOAD_IDEMPOTENCY_CONFLICT: commandId ${command.commandId} was already accepted with a different payload.`), { code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
      }
      if (seen.result) return seen.result;
      // A duplicate joins the original admission, queue wait and execution.
      // It must never compete for another VM or write an unavailable receipt.
      return await this.inFlight.get(key)!;
    }
    // This cache joins live waiters only. Durable replay is checked outside it.
    this.journal.set(key, { digest, result: null });
    const pending = this.executeAccepted(command);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private unavailable(command: OffloadCommand, reason: string): OffloadResult {
    return { status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: command.commandId, remoteStarted: false, fallbackSafe: true, reason };
  }

  private finish(commandId: string, result: OffloadResult): OffloadResult {
    const seen = this.journal.get(commandId)!;
    if (seen.result) return seen.result;
    seen.result = result;
    return result;
  }

  private async executeAccepted(command: OffloadCommand): Promise<OffloadResult> {
    const enqueuedAt = this.now();
    const claimed = await this.withAdmission(() => this.claimSlot(command));
    if (claimed.kind === "unavailable") return this.finish(this.cacheKey(command), this.unavailable(command, claimed.reason));
    const dispatch = claimed.kind === "queued" ? await claimed.wait : claimed;
    if (!("kind" in dispatch)) return dispatch;
    if (this.closed) {
      // Shutdown may have fenced a create/resume or handoff before spawn.
      const result = this.finish(this.cacheKey(command), this.unavailable(command, "executor shutdown"));
      await this.releaseVm(dispatch.vm);
      return result;
    }
    return await this.runOnVm(dispatch.vm, command, dispatch.warm, this.now() - enqueuedAt);
  }

  /**
   * The runtime caches one executor per pool, and the template is not part of
   * the pool identity, so later native bindings deliver the current selection
   * here. It applies to later claims and creates; recorded VMs keep the key
   * they were created with and are retired if it no longer matches.
   */
  setTemplateSnapshot(name: string | null): void {
    this.config.templateSnapshot = name;
  }

  private compatibilityKey(command: OffloadCommand): string {
    // A VM booted from another guest image is never reused; it is retired like
    // any incompatible idle VM. Without a template the key is unchanged, so VMs
    // recorded before templates existed stay reusable.
    const base = [command.companyId, command.repoId, command.profileId, command.trustDomainId ?? null];
    return JSON.stringify(this.config.templateSnapshot ? [...base, this.config.templateSnapshot] : base);
  }

  private workspaceKey(command: OffloadCommand): string | null {
    // Legacy identity-only callers without a workspace keep their old contract.
    // Lifecycle callers lacking the newer binding conservatively reserve a card.
    const workspace = command.executionWorkspaceId ?? (this.lifecycle ? command.cardId : null);
    return workspace === null ? null : JSON.stringify([command.companyId, workspace]);
  }

  private reserveVm(vm: PoolVm, command: OffloadCommand): Reservation {
    vm.busy = true;
    vm.workspaceKey = this.workspaceKey(command);
    vm.generation += 1;
    this.clearIdleTimer(vm);
    vm.stopDueAt = null;
    vm.stopRequestedAt = null;
    vm.stopObservedAt = null;
    vm.stopAttempts = 0;
    this.stopFailures.delete(vm.sandboxId);
    return { kind: "run", vm, warm: "warm" };
  }

  // Runs under admission. A blocked workspace cannot consume a second VM,
  // and a quarantined reservation remains exclusive after its call settles.
  private async tryClaimSlot(command: OffloadCommand): Promise<Slot> {
    if (this.closed) return { kind: "unavailable", reason: "executor shutdown" };
    const cancelled = this.durable?.preStartResult(command);
    if (cancelled?.status === "unavailable") return { kind: "unavailable", reason: cancelled.reason };
    if (this.lifecycle && this.pool.some((vm) => vm.quarantined && vm.workspaceKey === undefined)) {
      return { kind: "unavailable", reason: "recovered workspace ownership unknown; reconciliation required" };
    }
    const workspace = this.workspaceKey(command);
    const held = workspace === null ? undefined : this.pool.find((vm) =>
      vm.workspaceKey === workspace && (vm.busy || vm.quarantined));
    if (held?.quarantined) return { kind: "unavailable", reason: "workspace quarantined; guest reconciliation required" };
    if (held) return { kind: "blocked" };
    const compatible = (vm: PoolVm) => vm.compatibilityKey === this.compatibilityKey(command);
    // A stop may have finished since its asynchronous acceptance. Observe the
    // exact allocation before resuming it; never try resume while archiving.
    for (const vm of [...this.pool]) {
      if (vm.quarantined) continue;
      if (vm.stopping) await this.observeStop(vm);
      else if (vm.stopped) {
        try { await this.persistStopTelemetry(vm); }
        catch { return { kind: "unavailable", reason: "stop accounting persistence pending" }; }
      }
    }
    // Warmest idle first (running, not stopped or uncertain).
    let best: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || vm.stopped || vm.stopping || vm.quarantined || !compatible(vm)) continue;
      if (!best || vm.lastActiveAt > best.lastActiveAt) best = vm;
    }
    if (best) return this.accountClaim(command, best, "warm");
    // Most recently stopped compatible VM next.
    let stopped: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || !vm.stopped || vm.stopping || vm.quarantined || !compatible(vm)) continue;
      if (!stopped || vm.lastActiveAt > stopped.lastActiveAt) stopped = vm;
    }
    if (stopped) return this.accountClaim(command, stopped, "resume");
    if (this.pool.length < this.config.maxOffloadVms) return this.accountClaim(command, null, "create");
    // An idle incompatible cache must not permanently consume a bounded slot.
    // Preserve its ownership until stop and telemetry are both confirmed; never
    // reclaim busy, quarantined or asynchronously stopping allocations.
    const retiring = this.pool.find((vm) => !vm.busy && !vm.quarantined && !vm.stopping && !compatible(vm));
    if (retiring) {
      this.clearIdleTimer(retiring);
      if (retiring.stopped && retiring.stopObservedAt == null) {
        // Replay release permits admission, not proof of provider termination.
        // Fence uncertain ownership so stop observation/retries retain coverage.
        retiring.stopped = false;
        retiring.stopping = true;
        if (await this.observeStop(retiring)) await this.stopVm(retiring, true);
      } else if (!retiring.stopped) await this.stopVm(retiring);
      if (this.pool.includes(retiring) && (!retiring.stopped || retiring.stopObservedAt == null)) {
        await this.persistPool();
        this.scheduleIdleStop(retiring, retiring.generation, 1000);
        return { kind: "unavailable", reason: "incompatible pool retirement pending; reconciliation required" };
      }
      try { await this.persistStopTelemetry(retiring); }
      catch { return { kind: "unavailable", reason: "stop accounting persistence pending" }; }
      this.retireVm(retiring);
      await this.persistPool();
      return this.accountClaim(command, null, "create");
    }
    // An uncertain slot has no live release event to queue behind. Refuse
    // rather than strand callers waiting for a nonexistent safe handoff.
    if (!this.pool.some((vm) => compatible(vm) && vm.busy && !vm.quarantined)) {
      return { kind: "unavailable", reason: "no compatible pool capacity; guest reconciliation required" };
    }
    return { kind: "blocked" };
  }

  private async claimSlot(command: OffloadCommand): Promise<Claim> {
    const claim = await this.tryClaimSlot(command);
    if (claim.kind !== "blocked") return claim;
    if ((command.queueTimeoutMs ?? this.config.queueTimeoutMs) <= 0) return { kind: "unavailable", reason: "queue wait disabled" };
    if (this.queue.length >= this.config.queueLimit) {
      return { kind: "unavailable", reason: `queue full (${this.config.queueLimit} pending)` };
    }
    const timeoutMs = command.queueTimeoutMs ?? this.config.queueTimeoutMs;
    let resolveWait!: Queued["resolve"];
    let rejectWait!: Queued["reject"];
    const wait = new Promise<Dispatch>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const entry: Queued = { command, resolve: resolveWait, reject: rejectWait, timerHandle: null, refusal: null };
    // Queue expiry and dispatch compare-and-transition under the same lock.
    entry.timerHandle = this.timers.set(() => {
      void this.withAdmission(async () => {
        if (!this.queue.includes(entry)) return;
        void this.refuseQueued(entry, `queue timeout after ${timeoutMs} ms`);
      }).catch(() => this.logger.warn("boat offload queue timeout could not acquire admission", { commandId: command.commandId }));
    }, timeoutMs);
    this.queue.push(entry);
    return { kind: "queued", wait };
  }

  private async cancelQueued(command: OffloadCommand, result: OffloadResult): Promise<void> {
    await this.withAdmission(async () => {
      const at = this.queue.findIndex((entry) => this.cacheKey(entry.command) === this.cacheKey(command));
      if (at < 0) return;
      const [entry] = this.queue.splice(at, 1);
      if (entry!.timerHandle != null) this.timers.clear(entry!.timerHandle);
      entry!.timerHandle = null;
      entry!.resolve(this.finish(this.cacheKey(command), result));
    });
  }

  // Called under admission, but never await storage while holding that lock.
  // A refusing (including failed-refusal) entry occupies capacity and cannot
  // receive a VM until its durable never-started result has been committed.
  private refuseQueued(entry: Queued, reason: string): Promise<void> {
    if (entry.refusal) return entry.refusal;
    if (entry.timerHandle != null) this.timers.clear(entry.timerHandle);
    entry.timerHandle = null;
    entry.refusal = (async () => {
      let result = this.unavailable(entry.command, reason);
      try {
        if (this.durable) result = await this.durable.finish(entry.command, result);
        await this.cancelQueued(entry.command, result);
      } catch (error) {
        entry.reject(error);
        this.logger.warn("boat offload queue refusal uncommitted; slot retained", { commandId: entry.command.commandId });
      }
    })();
    return entry.refusal;
  }

  private async accountClaim(command: OffloadCommand, existing: PoolVm | null, operation: "create" | "resume" | "warm"): Promise<Reservation | { kind: "unavailable"; reason: string }> {
    const ledger = this.ledger!;
    // Monthly VM-hour cap, when configured, is enforced atomically with
    // admission inside the ledger lock: fail closed on telemetry errors and
    // count pending envelopes so concurrent claims cannot burst past the cap.
    const monthCap = this.config.offloadMonthlyVmHourCap ?? 0;
    // Fund the provider-enforced TTL envelope, not the raw timeout: create,
    // resume and warm update all clamp the deadline to whole seconds with a
    // 60 s minimum. A 16 s reservation must not create a 60 s billing VM.
    const jobSeconds = Math.max(Math.ceil((command.timeoutMs ?? 120_000) / 1000), 60 - this.config.offloadIdleStopSeconds);
    let reservation: AccountReservation;
    try {
      reservation = await ledger.reserve(this.boat, { ...this.config, operation, sandboxId: existing?.sandboxId, poolId: this.poolId,
        jobSeconds, tailSeconds: this.config.offloadIdleStopSeconds,
        command: { commandId: command.commandId, runId: command.runId, cardId: command.cardId, repoId: command.repoId,
          companyId: command.companyId, profileId: command.profileId, payloadDigest: createHash("sha256").update(digestOf(command)).digest("hex") },
        ...(monthCap > 0 ? { monthlyCap: { companyId: command.companyId, nowMs: this.now(), capHours: monthCap } } : {}) });
    } catch (error) {
      if (error instanceof Error && error.message.includes("monthly offload VM-hour cap reached")) {
        return { kind: "unavailable", reason: `monthly offload VM-hour cap reached (${monthCap}h); new commands run local until next month` };
      }
      return { kind: "unavailable", reason: "account admission refused: limits, capacity or durable state unavailable" };
    }
    const vm = existing ?? { sandboxId: "", busy: true, stopped: false, quarantined: false, lastActiveAt: this.now(), generation: 0, idleHandle: null, stopDueAt: null, stopAttempts: 0,
      stopping: false, stopRequestedAt: null, identity: null, compatibilityKey: this.compatibilityKey(command) };
    this.reserveVm(vm, command);
    vm.accountReservation = reservation;
    vm.tailSeconds = reservation.tailSeconds;
    if (!existing) this.pool.push(vm);
    // Funded whole seconds at or above the enforced minimum, so the enforced
    // deadline below equals the funded envelope exactly.
    const ttlSeconds = Math.max(60, Math.ceil(jobSeconds + reservation.tailSeconds));
    let effectConfirmed = operation === "warm";
    try {
      await this.persistPool();
      if (operation === "create") {
        // Same semantics as whole-run leases (vm-manager): a configured named
        // snapshot is the guest image; a missing one is a refused start, so the
        // command stays local.
        const response = await this.boat.create({ type: this.config.size, ttlSeconds, monitoring: true, failFast: true, noEnv: true,
          ...(this.config.templateSnapshot ? { from: this.config.templateSnapshot } : {}) });
        const id = sandboxIdOf(response);
        if (!id) throw new Error("create returned no sandbox id");
        vm.sandboxId = id;
      } else if (operation === "resume") {
        await this.boat.resume({ sandboxId: vm.sandboxId, ttlSeconds });
      } else {
        // Warm activity also needs a newly funded provider-enforced deadline.
        await this.boat.update({ sandboxId: vm.sandboxId, ttlSeconds });
      }
      effectConfirmed = true;
      vm.stopped = false;
      vm.tailSeconds = await ledger.started(this.boat, reservation, vm.sandboxId);
      // A metered resume may select C=300. Keep provider auto-stop aligned with
      // the longer, already-funded reservation before starting the command.
      if (vm.tailSeconds > reservation.tailSeconds) await this.boat.update({ sandboxId: vm.sandboxId,
        ttlSeconds: Math.max(60, Math.ceil(jobSeconds + vm.tailSeconds)) });
      await this.persistPool();
      return { kind: "run", vm, warm: operation === "warm" ? "warm" : "cold" };
    } catch (error) {
      const definitive = !effectConfirmed && await definitiveStartRejection(error);
      await ledger.failed(reservation, definitive).catch(() => {
        // The original durable intent remains held. No command was dispatched;
        // a failing follow-up write must not poison the idempotency receipt.
        this.logger.error("boat offload start reconciliation persistence failed; intent retained");
      });
      vm.busy = false;
      if (definitive) vm.workspaceKey = null;
      if (!definitive) vm.quarantined = true;
      else if (!existing) this.retireVm(vm);
      await this.persistPool().catch(() => { vm.quarantined = true; });
      return { kind: "unavailable", reason: definitive ? "provider rejected start; no command dispatched" : "start outcome uncertain; reservation retained, no command dispatched" };
    }
  }

  private async runOnVm(vm: PoolVm, command: OffloadCommand, warm: OffloadWarm, queueWaitMs: number): Promise<OffloadResult> {
    const startedAt = this.now();
    let result: OffloadResult;
    try {
      const raw = await this.runCommand(vm.sandboxId, command);
      const { exitCode, seconds } = raw;
      const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
      result = { status: "completed", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, exitCode, seconds, dollars,
        ...(raw.syncBack ? { syncBack: raw.syncBack } : {}),
        ...(this.lifecycle ? { remoteStarted: true as const, fallbackSafe: false as const,
          cancelled: raw.cancelled === true, timedOut: raw.timedOut === true } : {}) };
    } catch {
      const seconds = Math.max(0, (this.now() - startedAt) / 1000);
      const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
      result = { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, remoteStarted: true, fallbackSafe: false, exitCode: 75, seconds, dollars, reason: "command transport failed; reconcile the guest receipt before replay or VM reuse" };
    }
    try {
      if (this.durable) result = await this.durable.finish(command, result);
    } catch (error) {
      await this.quarantineVm(vm, command);
      throw error;
    }
    this.finish(this.cacheKey(command), result);
    if (result.status === "unavailable") {
      // A durable cancellation won the race after admission: no command ran.
      // Close the funded reservation with a zero-length command interval.
      await this.ledger.finished(vm.accountReservation!, false, {
        warm, queueWaitMs, exitCode: 0, outcome: "completed", expectedSeconds: 0, expectedDollars: 0,
      }).catch(() => {
        this.logger.error("boat offload usage persistence failed; account reservation retained");
      });
      await this.releaseVm(vm);
      return result;
    }
    let accountingFailed = false;
    await this.ledger.finished(vm.accountReservation!, result.status === "unknown", {
      warm, queueWaitMs, exitCode: result.exitCode, outcome: result.status, expectedSeconds: result.seconds, expectedDollars: result.dollars,
    }).catch(() => {
      accountingFailed = true;
      this.logger.error("boat offload usage persistence failed; VM quarantined and account reservation retained");
    });
    if (result.status === "completed") {
      // Feed the duration gate: completed remote runs teach the next decision.
      // A learning write never fails the command it just measured.
      try {
        await this.recordDuration?.(command, result.seconds);
      } catch (error) {
        this.logger.warn("boat offload duration recording failed", { commandId: command.commandId });
        void error;
      }
    }
    // Identity + accounting only, never argv/env or raw transport errors.
    this.logger.info(`boat offload expected-cost ${JSON.stringify({ commandId: command.commandId, repoId: command.repoId, size: this.config.size, warm, queueWaitMs, seconds: result.seconds, dollars: Number(result.dollars.toFixed(6)), outcome: result.status, estimated: result.status === "unknown" })}`, {
      commandId: command.commandId,
      repoId: command.repoId,
      sandboxId: vm.sandboxId,
      warm,
      queueWaitMs,
      seconds: result.seconds,
      dollars: result.dollars,
      outcome: result.status,
      estimated: result.status === "unknown",
    });
    if (result.status === "unknown" || accountingFailed) {
      await this.quarantineVm(vm, command);
    } else {
      await this.releaseVm(vm);
    }
    return result;
  }

  private async quarantineVm(vm: PoolVm, command: OffloadCommand): Promise<void> {
    await this.withAdmission(async () => {
      vm.quarantined = true;
      this.stopFailures.delete(vm.sandboxId);
      vm.busy = false;
      vm.generation += 1;
      this.clearIdleTimer(vm);
      await this.persistPool();
      this.logger.warn("boat offload VM quarantined; guest receipt reconciliation required", { commandId: command.commandId, sandboxId: vm.sandboxId });
      if (!this.closed) await this.dispatchQueued();
    });
  }

  // Preserve FIFO among eligible waiters without blocking other workspaces
  // behind a reserved workspace or handing an incompatible VM to the head.
  private async dispatchQueued(): Promise<void> {
    for (const entry of [...this.queue]) {
      if (entry.refusal || !this.queue.includes(entry)) continue;
      let claim: Slot;
      try { claim = await this.tryClaimSlot(entry.command); }
      catch (error) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        if (entry.timerHandle != null) this.timers.clear(entry.timerHandle);
        entry.reject(error);
        continue;
      }
      if (claim.kind === "blocked") continue;
      this.queue.splice(this.queue.indexOf(entry), 1);
      if (entry.timerHandle != null) this.timers.clear(entry.timerHandle);
      entry.timerHandle = null;
      entry.resolve(claim.kind === "unavailable"
        ? this.finish(this.cacheKey(entry.command), this.unavailable(entry.command, claim.reason)) : claim);
    }
  }

  private async releaseVm(vm: PoolVm): Promise<void> {
    await this.withAdmission(async () => {
      vm.lastActiveAt = this.now();
      vm.busy = false;
      vm.workspaceKey = null;
      vm.generation += 1;
      vm.stopAttempts = 0;
      vm.stopDueAt = this.now() + (this.closed ? 0 : (vm.tailSeconds ?? this.config.offloadIdleStopSeconds) * 1000);
      await this.persistPool();
      if (!this.closed) await this.dispatchQueued();
      // Dispatch may reserve this VM, retire it for an incompatible waiter,
      // or leave a stop retry installed. Never resurrect its old idle timer.
      if (!this.pool.includes(vm) || vm.busy || vm.quarantined || vm.stopped || vm.stopping || vm.idleHandle != null) return;
      if (this.closed) {
        await this.stopVm(vm);
      } else {
        this.scheduleIdleStop(vm, vm.generation, Math.max(0, vm.stopDueAt! - this.now()));
      }
    });
  }

  private clearIdleTimer(vm: PoolVm): void {
    if (vm.idleHandle != null) this.timers.clear(vm.idleHandle);
    vm.idleHandle = null;
  }

  private retireVm(vm: PoolVm): void {
    this.clearIdleTimer(vm);
    vm.generation += 1;
    const at = this.pool.indexOf(vm);
    if (at >= 0) this.pool.splice(at, 1);
  }

  private scheduleIdleStop(vm: PoolVm, generation: number, delayMs: number): void {
    vm.idleHandle = this.timers.set(() => {
      void this.withAdmission(async () => {
        if (!this.pool.includes(vm) || vm.generation !== generation || vm.busy || vm.stopped || vm.quarantined || this.closed) return;
        vm.idleHandle = null;
        let pending: boolean;
        if (vm.stopping && !await this.observeStop(vm)) {
          // An unreadable or archiving allocation is still owned. Only a
          // terminal observation (or retirement) ends bounded retries.
          pending = this.pool.includes(vm) && vm.stopping;
          if (pending) vm.stopAttempts += 1;
          await this.persistPool();
        } else {
          pending = !await this.stopVm(vm, vm.stopping) || vm.stopping;
        }
        if (pending) this.scheduleStopRetry(vm, generation);
      }).catch(() => {
        // The detached promise returned by withAdmission needs its own handler.
        // A failed pool write must not consume the only pending-stop retry.
        this.logger.error("boat offload idle stop observation failed; retry required", { sandboxId: vm.sandboxId });
        this.scheduleStopRetry(vm, generation);
      });
    }, delayMs);
  }

  private scheduleStopRetry(vm: PoolVm, generation: number): void {
    // Recheck after awaits/rejection: retirement, reuse or shutdown may have
    // superseded this callback. Never overwrite a newer generation's timer.
    if (!this.pool.includes(vm) || vm.generation !== generation || vm.busy || vm.stopped || vm.quarantined || this.closed || vm.idleHandle != null) return;
    const retryMs = Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, vm.stopAttempts - 1), 5));
    this.scheduleIdleStop(vm, generation, retryMs);
  }

  private async stopVm(vm: PoolVm, retryPending = false): Promise<boolean> {
    if ((vm.stopping && !retryPending) || vm.stopped || vm.quarantined || vm.busy) return true;
    vm.stopAttempts += 1;
    vm.stopRequestedAt ??= this.now();
    // Request intent is durable before the RPC; it is not a stopped receipt.
    vm.stopping = true;
    try {
      await this.persistStopTelemetry(vm);
    } catch {
      // Storage loss cannot justify leaving a known-empty idle VM billing.
      // Preserve pending telemetry; never fabricate a persisted stop receipt.
      this.logger.error("boat offload stop intent persistence failed; reconciliation required", { sandboxId: vm.sandboxId });
    }
    await this.persistPool().catch(() => {
      this.logger.error("boat offload stop intent persistence failed; reconciliation required", { sandboxId: vm.sandboxId });
    });
    // The provider stop alone decides success. A ledger failure afterwards must
    // not read as a failed stop: the VM is already stopped, and retrying the
    // stop (or treating the VM as warm) would bill or quarantine wrongly.
    // Unrecorded receipts converge on the next reconcile().
    let response: unknown;
    try {
      response = await this.boat.stop({ sandboxId: vm.sandboxId });
    } catch (error) {
      // In lifecycle mode a lost reply may hide an accepted asynchronous stop.
      // Keep that capacity fenced; only explicit rejection permits warm reuse.
      vm.stopping = this.lifecycle !== null && !await definitiveStartRejection(error);
      await this.persistPool().catch(() => {});
      this.stopFailures.add(vm.sandboxId);
      this.logger.warn("boat offload idle stop failed; retry required", { sandboxId: vm.sandboxId, attempt: vm.stopAttempts });
      return false;
    }
    const state = sandboxStateOf(response, vm.sandboxId);
    vm.stopped = state === "archived" || state === "cancelled";
    vm.stopping = !vm.stopped;
    vm.stopObservedAt = vm.stopped ? this.now() : null;
    await this.persistStopTelemetry(vm).catch(() => {
      this.logger.error("boat offload stop receipt persistence failed; reconcile will converge", { sandboxId: vm.sandboxId });
    });
    this.stopFailures.delete(vm.sandboxId);
    await this.persistPool().catch(() => {
      this.logger.error("boat offload stop state persistence failed; reconciliation required", { sandboxId: vm.sandboxId });
    });
    this.logger.info("boat offload idle stop accepted", { sandboxId: vm.sandboxId, attempts: vm.stopAttempts,
      stoppedAt: vm.stopped ? this.now() : null,
      stopLagMs: vm.stopped ? Math.max(0, this.now() - (vm.stopDueAt ?? this.now())) : null });
    return true;
  }
}
