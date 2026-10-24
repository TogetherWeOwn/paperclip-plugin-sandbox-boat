// v1 offload executor: one heavy command on a shared pool VM.
// Design: docs/adr/0001-heavy-command-offload.md.
//
// Scope: warm pick, resume/create up to maxOffloadVms, FIFO queue, idle stop
// after C with generation-guarded timers, start/compute budget fallback to
// OFFLOAD_UNAVAILABLE, per-command usage + expected-cost log, idempotency by
// commandId. Durable journal/receipt recovery is injectable; live dispatch,
// guest lifecycle enforcement, sweep wiring and adaptive policy remain unwired.
import { checkBudget, readBudget } from "./budget.js";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { PRICE_PER_HOUR } from "./size-policy.js";
import { OffloadJournal, commandDigest, commandKey, type OffloadDurableDeps, type OffloadIdentity } from "./offload-journal.js";
export { OffloadGuestRunner } from "./offload-guest.js";
export type { OffloadStore, OffloadIdentity, OffloadRecord, OffloadCommandView, OffloadDurableDeps } from "./offload-journal.js";

export interface OffloadCommand {
  commandId: string;
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  argv: string[];
  executionWorkspaceId?: string;
  cwdRelative?: string;
  env?: Record<string, string>;
  queueTimeoutMs?: number;
  timeoutMs?: number;
}

export type OffloadWarm = "warm" | "cold";

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

export interface OffloadUsageRow {
  commandId: string;
  runId: string;
  cardId: string;
  repoId: string;
  sandboxId: string;
  warm: OffloadWarm;
  queueWaitMs: number;
  seconds: number;
  dollars: number;
  exitCode: number;
  outcome: "completed" | "unknown";
  // Unknown transport outcomes retain elapsed cost as a lower bound, not a bill.
  estimated: boolean;
  at: string;
}

export interface OffloadExecutorConfig {
  maxOffloadVms: number;
  offloadIdleStopSeconds: number;
  queueLimit?: number;
  queueTimeoutMs?: number;
  size?: BoatSize;
  maxActive?: number;
  maxStartsPerDay?: number;
  minComputeHoursLeft?: number;
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
  boat: BoatApiLike;
  logger: OffloadLogger;
  now: () => number;
  timers?: OffloadTimers;
  config: OffloadExecutorConfig;
  runCommand: (sandboxId: string, command: OffloadCommand, identity?: OffloadIdentity) => Promise<{ exitCode: number; seconds: number }>;
}

interface PoolVm {
  sandboxId: string;
  busy: boolean;
  stopped: boolean;
  quarantined: boolean;
  lastActiveAt: number;
  generation: number;
  idleHandle: unknown | null;
  stopDueAt: number | null;
  stopAttempts: number;
}

type Reservation = { kind: "run"; vm: PoolVm; warm: OffloadWarm };
type Dispatch = Reservation | OffloadResult;
type Claim = Reservation | { kind: "unavailable"; reason: string } | { kind: "queued"; wait: Promise<Dispatch> };

interface Queued {
  command: OffloadCommand;
  resolve: (result: Dispatch) => void;
  reject: (error: unknown) => void;
  timerHandle: unknown | null;
  refusal: Promise<void> | null;
}

function sandboxIdOf(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;
  const sandbox = root.sandbox as Record<string, unknown> | undefined;
  const id = sandbox?.id ?? root.id;
  return typeof id === "string" && id.length > 0 ? id : null;
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
  private readonly logger: OffloadLogger;
  private readonly now: () => number;
  private readonly timers: OffloadTimers;
  private readonly config: Required<Pick<OffloadExecutorConfig, "maxOffloadVms" | "offloadIdleStopSeconds">> &
    Required<Pick<OffloadExecutorConfig, "queueLimit" | "queueTimeoutMs" | "size" | "maxActive" | "maxStartsPerDay" | "minComputeHoursLeft">>;
  private readonly runCommand: OffloadDeps["runCommand"];
  private readonly durable: OffloadJournal | null;
  private readonly pool: PoolVm[] = [];
  private readonly queue: Queued[] = [];
  private readonly journal = new Map<string, { digest: string; result: OffloadResult | null }>();
  private readonly inFlight = new Map<string, Promise<OffloadResult>>();
  private readonly usage: OffloadUsageRow[] = [];
  private readonly stopFailures = new Set<string>();
  private admission: Promise<unknown> = Promise.resolve();
  private closed = false;
  private shutdownTask: Promise<void> | null = null;

  constructor(deps: OffloadDeps) {
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
    };
    const hasDurableDeps = deps.journalStore || deps.guestReceipts || deps.resolveRunState || deps.sync;
    if (hasDurableDeps && !(deps.journalStore && deps.guestReceipts && deps.resolveRunState && deps.sync)) {
      throw new Error("OFFLOAD_DURABLE_CONFIGURATION_REQUIRED");
    }
    this.durable = hasDurableDeps ? new OffloadJournal(deps as OffloadDeps & OffloadDurableDeps, this.now, {
      hold: (identity) => this.restoreHold(identity),
      release: (identity) => this.releaseHold(identity),
      cancel: (command, result) => this.cancelQueued(command, result),
    }) : null;
    this.runCommand = this.durable
      ? (vm, command) => this.durable!.run(vm, command, deps.runCommand)
      : deps.runCommand;
  }

  async recover(): Promise<void> { await this.requireDurable().recover(); }
  async collectGarbage(): Promise<void> { await this.requireDurable().collectGarbage(); }
  async readCommand(companyId: string, runId: string, commandId: string) {
    return await this.requireDurable().readCommand(companyId, runId, commandId);
  }
  async cancelCommand(companyId: string, runId: string, commandId: string, reason: string) {
    return await this.requireDurable().cancelCommand(companyId, runId, commandId, reason);
  }
  private requireDurable(): OffloadJournal {
    if (!this.durable) throw new Error("OFFLOAD_DURABLE_CONFIGURATION_REQUIRED");
    return this.durable;
  }

  private async restoreHold(identity: OffloadIdentity): Promise<void> {
    await this.withAdmission(async () => {
      let vm = this.pool.find((entry) => entry.sandboxId === identity.sandboxId);
      if (!vm) {
        vm = { sandboxId: identity.sandboxId, busy: false, stopped: false, quarantined: true,
          lastActiveAt: this.now(), generation: identity.journalGeneration, idleHandle: null, stopDueAt: null, stopAttempts: 0 };
        this.pool.push(vm);
      }
      vm.quarantined = true;
      vm.generation += 1;
      this.clearIdleTimer(vm);
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
      vm.stopped = true;
      vm.lastActiveAt = this.now();
    });
  }

  getUsage(): OffloadUsageRow[] {
    return [...this.usage];
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
      for (const vm of this.pool) {
        this.clearIdleTimer(vm);
        if (!vm.busy && !vm.stopped && !vm.quarantined) await this.stopVm(vm);
      }
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

  async execute(command: OffloadCommand): Promise<OffloadResult> {
    // Snapshot caller-owned objects before any await; mutating argv or env must
    // never change the payload after its durable digest was accepted.
    const snapshot = structuredClone(command);
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

  private reserveVm(vm: PoolVm): Reservation {
    vm.busy = true;
    vm.generation += 1;
    this.clearIdleTimer(vm);
    vm.stopDueAt = null;
    vm.stopAttempts = 0;
    this.stopFailures.delete(vm.sandboxId);
    return { kind: "run", vm, warm: "warm" };
  }

  private async claimSlot(command: OffloadCommand): Promise<Claim> {
    if (this.closed) return { kind: "unavailable", reason: "executor shutdown" };
    const cancelled = this.durable?.preStartResult(command);
    if (cancelled?.status === "unavailable") return { kind: "unavailable", reason: cancelled.reason };
    // Warmest idle first (running, not stopped or uncertain).
    let best: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || vm.stopped || vm.quarantined) continue;
      if (!best || vm.lastActiveAt > best.lastActiveAt) best = vm;
    }
    if (best) return this.reserveVm(best);
    // Most recently stopped compatible VM next.
    let stopped: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || !vm.stopped || vm.quarantined) continue;
      if (!stopped || vm.lastActiveAt > stopped.lastActiveAt) stopped = vm;
    }
    if (stopped) {
      const refusal = await this.budgetRefusal();
      if (refusal) return { kind: "unavailable", reason: refusal };
      this.reserveVm(stopped);
      try {
        await this.boat.resume({ sandboxId: stopped.sandboxId });
      } catch (error) {
        stopped.busy = false;
        return { kind: "unavailable", reason: `resume failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      stopped.stopped = false;
      return { kind: "run", vm: stopped, warm: "cold" };
    }
    if (this.pool.length < this.config.maxOffloadVms) {
      const refusal = await this.budgetRefusal();
      if (refusal) return { kind: "unavailable", reason: refusal };
      const placeholder: PoolVm = { sandboxId: "", busy: true, stopped: false, quarantined: false, lastActiveAt: this.now(), generation: 0, idleHandle: null, stopDueAt: null, stopAttempts: 0 };
      this.pool.push(placeholder);
      try {
        const response = await this.boat.create({ type: this.config.size, ttlSeconds: 7200, monitoring: false, failFast: true, noEnv: true });
        const id = sandboxIdOf(response);
        if (!id) throw new Error("boat create returned no sandbox id.");
        placeholder.sandboxId = id;
      } catch (error) {
        const at = this.pool.indexOf(placeholder);
        if (at >= 0) this.pool.splice(at, 1);
        return { kind: "unavailable", reason: `create failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { kind: "run", vm: placeholder, warm: "cold" };
    }
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

  private async budgetRefusal(): Promise<string | null> {
    let limits: unknown;
    try {
      limits = await this.boat.limits({});
    } catch (error) {
      return `limits unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const snapshot = readBudget(limits);
    const refusal = checkBudget(snapshot, { maxActive: this.config.maxActive, maxStartsPerDay: this.config.maxStartsPerDay, minComputeHoursLeft: this.config.minComputeHoursLeft } as Parameters<typeof checkBudget>[1], this.config.size);
    if (refusal) return `${refusal.limit}: ${refusal.message}`;
    return null;
  }

  private async runOnVm(vm: PoolVm, command: OffloadCommand, warm: OffloadWarm, queueWaitMs: number): Promise<OffloadResult> {
    const startedAt = this.now();
    let result: OffloadResult;
    try {
      const { exitCode, seconds } = await this.runCommand(vm.sandboxId, command);
      const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
      result = { status: "completed", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, exitCode, seconds, dollars };
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
      await this.releaseVm(vm);
      return result;
    }
    this.usage.push({ commandId: command.commandId, runId: command.runId, cardId: command.cardId, repoId: command.repoId, sandboxId: vm.sandboxId, warm, queueWaitMs, seconds: result.seconds, dollars: result.dollars, exitCode: result.exitCode, outcome: result.status, estimated: result.status === "unknown", at: new Date(this.now()).toISOString() });
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
    if (result.status === "unknown") {
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
      this.logger.warn("boat offload VM quarantined; guest receipt reconciliation required", { commandId: command.commandId, sandboxId: vm.sandboxId });
    });
  }

  private async releaseVm(vm: PoolVm): Promise<void> {
    await this.withAdmission(async () => {
      vm.lastActiveAt = this.now();
      if (!this.closed) {
        const nextAt = this.queue.findIndex((entry) => !entry.refusal);
        const next = nextAt >= 0 ? this.queue.splice(nextAt, 1)[0] : undefined;
        if (next) {
          if (next.timerHandle != null) this.timers.clear(next.timerHandle);
          next.timerHandle = null;
          // Transfer a busy reservation, not an idle VM to rediscover. A new
          // arrival cannot steal this VM before the FIFO waiter continues.
          next.resolve(this.reserveVm(vm));
          return;
        }
      }
      vm.busy = false;
      vm.generation += 1;
      vm.stopAttempts = 0;
      vm.stopDueAt = this.now() + (this.closed ? 0 : this.config.offloadIdleStopSeconds * 1000);
      if (this.closed) {
        await this.stopVm(vm);
      } else {
        this.scheduleIdleStop(vm, vm.generation, this.config.offloadIdleStopSeconds * 1000);
      }
    });
  }

  private clearIdleTimer(vm: PoolVm): void {
    if (vm.idleHandle != null) this.timers.clear(vm.idleHandle);
    vm.idleHandle = null;
  }

  private scheduleIdleStop(vm: PoolVm, generation: number, delayMs: number): void {
    vm.idleHandle = this.timers.set(() => {
      void this.withAdmission(async () => {
        if (vm.generation !== generation || vm.busy || vm.stopped || vm.quarantined || this.closed) return;
        vm.idleHandle = null;
        if (!await this.stopVm(vm)) {
          // Keep ownership after a transient stop failure. New reservations
          // cancel this retry and invalidate its generation just like a tail.
          const retryMs = Math.min(30_000, 1000 * 2 ** Math.min(vm.stopAttempts - 1, 5));
          this.scheduleIdleStop(vm, generation, retryMs);
        }
      });
    }, delayMs);
  }

  private async stopVm(vm: PoolVm): Promise<boolean> {
    vm.stopAttempts += 1;
    try {
      await this.boat.stop({ sandboxId: vm.sandboxId });
    } catch {
      this.stopFailures.add(vm.sandboxId);
      this.logger.warn("boat offload idle stop failed; retry required", { sandboxId: vm.sandboxId, attempt: vm.stopAttempts });
      return false;
    }
    this.stopFailures.delete(vm.sandboxId);
    vm.stopped = true;
    vm.lastActiveAt = this.now();
    this.logger.info("boat offload idle stop accepted", { sandboxId: vm.sandboxId, stopLagMs: Math.max(0, this.now() - (vm.stopDueAt ?? this.now())), attempts: vm.stopAttempts });
    return true;
  }
}
