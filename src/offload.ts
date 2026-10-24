// v1 offload executor: one heavy command on a shared pool VM.
// Design: docs/adr/0001-heavy-command-offload.md.
//
// Scope: warm pick, resume/create up to maxOffloadVms, FIFO queue, idle stop
// after C with generation-guarded timers, start/compute budget fallback to
// OFFLOAD_UNAVAILABLE, per-command usage + expected-cost log, idempotency by
// commandId. Account admission and usage are durable; command receipt recovery,
// sync adapter and cancel/read routes remain separate, unwired slices.
import { createHash } from "node:crypto";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { PRICE_PER_HOUR } from "./size-policy.js";
import { AccountLedger, definitiveStartRejection } from "./account-ledger.js";
import type { AccountReservation, AccountUsageRow } from "./account-ledger.js";
import type { StateClientLike } from "./state.js";

export interface OffloadCommand {
  commandId: string;
  companyId: string;
  runId: string;
  cardId: string;
  repoId: string;
  profileId: string;
  argv: string[];
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

export interface OffloadDeps {
  state: StateClientLike;
  // Stable, credential-free provider identity, shared with the whole-run manager.
  accountId: string;
  poolId: string;
  boat: BoatApiLike;
  logger: OffloadLogger;
  now: () => number;
  timers?: OffloadTimers;
  config: OffloadExecutorConfig;
  runCommand: (sandboxId: string, command: OffloadCommand) => Promise<{ exitCode: number; seconds: number }>;
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
  accountReservation?: AccountReservation;
  tailSeconds?: number;
}

type Reservation = { kind: "run"; vm: PoolVm; warm: OffloadWarm };
type Dispatch = Reservation | OffloadResult;
type Claim = Reservation | { kind: "unavailable"; reason: string } | { kind: "queued"; wait: Promise<Dispatch> };

interface Queued {
  command: OffloadCommand;
  resolve: (result: Dispatch) => void;
  timerHandle: unknown | null;
}

function digestOf(command: OffloadCommand): string {
  // Internal payload identity; never included in logs or usage.
  return JSON.stringify({ repoId: command.repoId, profileId: command.profileId, argv: command.argv });
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
  private readonly ledger: AccountLedger;
  private readonly poolId: string;
  private readonly logger: OffloadLogger;
  private readonly now: () => number;
  private readonly timers: OffloadTimers;
  private readonly config: Required<Pick<OffloadExecutorConfig, "maxOffloadVms" | "offloadIdleStopSeconds">> &
    Required<Pick<OffloadExecutorConfig, "queueLimit" | "queueTimeoutMs" | "size" | "maxActive" | "maxStartsPerDay" | "minComputeHoursLeft">>;
  private readonly runCommand: OffloadDeps["runCommand"];
  private readonly pool: PoolVm[] = [];
  private readonly queue: Queued[] = [];
  private readonly journal = new Map<string, { digest: string; result: OffloadResult | null }>();
  private readonly inFlight = new Map<string, Promise<OffloadResult>>();
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
    this.runCommand = deps.runCommand;
    if (!(deps.state && deps.accountId && deps.poolId)) throw new Error("account admission requires durable state, accountId and poolId");
    this.poolId = deps.poolId;
    this.ledger = new AccountLedger(deps.state, deps.accountId, this.now);
  }

  getUsage(): AccountUsageRow[] {
    return this.ledger.usage(this.poolId);
  }

  async reconcile(): Promise<void> {
    await this.ledger.reconcile(this.boat);
  }

  async shutdown(): Promise<void> {
    // Fence synchronously, before waiting for admission or a provider response.
    // Existing IDs still return their real receipt, never a false safe fallback.
    this.closed = true;
    if (this.shutdownTask) return await this.shutdownTask;
    const pending = [...this.inFlight.values()];
    const task = this.drain(pending);
    this.shutdownTask = task;
    try {
      await task;
    } finally {
      this.shutdownTask = null;
    }
  }

  private async drain(pending: Promise<OffloadResult>[]): Promise<void> {
    await this.withAdmission(async () => {
      for (const entry of this.queue.splice(0)) {
        if (entry.timerHandle != null) this.timers.clear(entry.timerHandle);
        entry.resolve(this.finish(entry.command.commandId, this.unavailable(entry.command, "executor shutdown")));
      }
      for (const vm of this.pool) {
        this.clearIdleTimer(vm);
        if (!vm.busy && !vm.stopped && !vm.quarantined) await this.stopVm(vm);
      }
    });
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
    const digest = digestOf(command);
    const seen = this.journal.get(command.commandId);
    if (seen) {
      if (seen.digest !== digest) {
        throw Object.assign(new Error(`OFFLOAD_IDEMPOTENCY_CONFLICT: commandId ${command.commandId} was already accepted with a different payload.`), { code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
      }
      if (seen.result) return seen.result;
      // A duplicate joins the original admission, queue wait and execution.
      // It must never compete for another VM or write an unavailable receipt.
      return await this.inFlight.get(command.commandId)!;
    }
    // Intent and the shared promise are installed synchronously before any
    // admission callback can run. Persistence across restarts is still unwired.
    this.journal.set(command.commandId, { digest, result: null });
    const pending = this.executeAccepted(command);
    this.inFlight.set(command.commandId, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(command.commandId);
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
    if (claimed.kind === "unavailable") return this.finish(command.commandId, this.unavailable(command, claimed.reason));
    const dispatch = claimed.kind === "queued" ? await claimed.wait : claimed;
    if (!("kind" in dispatch)) return dispatch;
    if (this.closed) {
      // Shutdown may have fenced a create/resume or handoff before spawn.
      const result = this.finish(command.commandId, this.unavailable(command, "executor shutdown"));
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
    // Warmest idle first (running, not stopped or uncertain).
    let best: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || vm.stopped || vm.quarantined) continue;
      if (!best || vm.lastActiveAt > best.lastActiveAt) best = vm;
    }
    if (best) return this.accountClaim(command, best, "warm");
    // Most recently stopped compatible VM next.
    let stopped: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || !vm.stopped || vm.quarantined) continue;
      if (!stopped || vm.lastActiveAt > stopped.lastActiveAt) stopped = vm;
    }
    if (stopped) return this.accountClaim(command, stopped, "resume");
    if (this.pool.length < this.config.maxOffloadVms) return this.accountClaim(command, null, "create");
    if (this.queue.length >= this.config.queueLimit) {
      return { kind: "unavailable", reason: `queue full (${this.config.queueLimit} pending)` };
    }
    const timeoutMs = command.queueTimeoutMs ?? this.config.queueTimeoutMs;
    let resolveWait!: Queued["resolve"];
    const wait = new Promise<Dispatch>((resolve) => {
      resolveWait = resolve;
    });
    const entry: Queued = { command, resolve: resolveWait, timerHandle: null };
    // Queue expiry and dispatch compare-and-transition under the same lock.
    entry.timerHandle = this.timers.set(() => {
      void this.withAdmission(async () => {
        const at = this.queue.indexOf(entry);
        if (at < 0) return;
        const result = this.finish(command.commandId, this.unavailable(command, `queue timeout after ${timeoutMs} ms`));
        this.queue.splice(at, 1);
        entry.timerHandle = null;
        entry.resolve(result);
      });
    }, timeoutMs);
    this.queue.push(entry);
    return { kind: "queued", wait };
  }

  private async accountClaim(command: OffloadCommand, existing: PoolVm | null, operation: "create" | "resume" | "warm"): Promise<Reservation | { kind: "unavailable"; reason: string }> {
    const ledger = this.ledger!;
    let reservation: AccountReservation;
    try {
      reservation = await ledger.reserve(this.boat, { ...this.config, operation, sandboxId: existing?.sandboxId, poolId: this.poolId,
        jobSeconds: (command.timeoutMs ?? 120_000) / 1000, tailSeconds: this.config.offloadIdleStopSeconds,
        command: { commandId: command.commandId, runId: command.runId, cardId: command.cardId, repoId: command.repoId,
          companyId: command.companyId, profileId: command.profileId, payloadDigest: createHash("sha256").update(digestOf(command)).digest("hex") } });
    } catch {
      return { kind: "unavailable", reason: "account admission refused: limits, capacity or durable state unavailable" };
    }
    const vm = existing ?? { sandboxId: "", busy: true, stopped: false, quarantined: false, lastActiveAt: this.now(), generation: 0, idleHandle: null, stopDueAt: null, stopAttempts: 0 };
    this.reserveVm(vm);
    vm.accountReservation = reservation;
    vm.tailSeconds = reservation.tailSeconds;
    if (!existing) this.pool.push(vm);
    let effectConfirmed = operation === "warm";
    try {
      if (operation === "create") {
        const response = await this.boat.create({ type: this.config.size, ttlSeconds: Math.max(60, Math.ceil((command.timeoutMs ?? 120_000) / 1000 + reservation.tailSeconds)), monitoring: false, failFast: true, noEnv: true });
        const id = sandboxIdOf(response);
        if (!id) throw new Error("create returned no sandbox id");
        vm.sandboxId = id;
      } else if (operation === "resume") {
        await this.boat.resume({ sandboxId: vm.sandboxId, ttlSeconds: Math.max(60, Math.ceil((command.timeoutMs ?? 120_000) / 1000 + reservation.tailSeconds)) });
      } else {
        // Warm activity also needs a newly funded provider-enforced deadline.
        await this.boat.update({ sandboxId: vm.sandboxId, ttlSeconds: Math.max(60, Math.ceil((command.timeoutMs ?? 120_000) / 1000 + reservation.tailSeconds)) });
      }
      effectConfirmed = true;
      vm.stopped = false;
      vm.tailSeconds = await ledger.started(this.boat, reservation, vm.sandboxId);
      // A metered resume may select C=300. Keep provider auto-stop aligned with
      // the longer, already-funded reservation before starting the command.
      if (vm.tailSeconds > reservation.tailSeconds) await this.boat.update({ sandboxId: vm.sandboxId,
        ttlSeconds: Math.max(60, Math.ceil((command.timeoutMs ?? 120_000) / 1000 + vm.tailSeconds)) });
      return { kind: "run", vm, warm: operation === "warm" ? "warm" : "cold" };
    } catch (error) {
      const definitive = !effectConfirmed && await definitiveStartRejection(error);
      await ledger.failed(reservation, definitive).catch(() => {
        // The original durable intent remains held. No command was dispatched;
        // a failing follow-up write must not poison the idempotency receipt.
        this.logger.error("boat offload start reconciliation persistence failed; intent retained");
      });
      vm.busy = false;
      if (!definitive) vm.quarantined = true;
      else if (!existing) this.pool.splice(this.pool.indexOf(vm), 1);
      return { kind: "unavailable", reason: definitive ? "provider rejected start; no command dispatched" : "start outcome uncertain; reservation retained, no command dispatched" };
    }
  }

  private async runOnVm(vm: PoolVm, command: OffloadCommand, warm: OffloadWarm, queueWaitMs: number): Promise<OffloadResult> {
    const startedAt = this.now();
    let result: Extract<OffloadResult, { status: "completed" | "unknown" }>;
    try {
      const { exitCode, seconds } = await this.runCommand(vm.sandboxId, command);
      const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
      result = { status: "completed", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, exitCode, seconds, dollars };
    } catch {
      const seconds = Math.max(0, (this.now() - startedAt) / 1000);
      const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
      result = { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, remoteStarted: true, fallbackSafe: false, exitCode: 75, seconds, dollars, reason: "command transport failed; reconcile the guest receipt before replay or VM reuse" };
    }
    this.finish(command.commandId, result);
    let accountingFailed = false;
    await this.ledger.finished(vm.accountReservation!, result.status === "unknown", {
      warm, queueWaitMs, exitCode: result.exitCode, outcome: result.status, expectedSeconds: result.seconds, expectedDollars: result.dollars,
    }).catch(() => {
      accountingFailed = true;
      this.logger.error("boat offload usage persistence failed; VM quarantined and account reservation retained");
    });
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
      await this.withAdmission(async () => {
        vm.quarantined = true;
        this.stopFailures.delete(vm.sandboxId);
        vm.busy = false;
        vm.generation += 1;
        this.clearIdleTimer(vm);
        this.logger.warn("boat offload VM quarantined; guest receipt reconciliation required", { commandId: command.commandId, sandboxId: vm.sandboxId });
      });
    } else {
      await this.releaseVm(vm);
    }
    return result;
  }

  private async releaseVm(vm: PoolVm): Promise<void> {
    await this.withAdmission(async () => {
      vm.lastActiveAt = this.now();
      if (!this.closed) {
        const next = this.queue.shift();
        if (next) {
          if (next.timerHandle != null) this.timers.clear(next.timerHandle);
          next.timerHandle = null;
          // Transfer a busy reservation, not an idle VM to rediscover. A new
          // arrival cannot steal this VM before the FIFO waiter continues.
          const claim = await this.accountClaim(next.command, vm, "warm");
          next.resolve(claim.kind === "unavailable" ? this.finish(next.command.commandId, this.unavailable(next.command, claim.reason)) : claim);
          if (claim.kind === "run") return;
        }
      }
      vm.busy = false;
      vm.generation += 1;
      vm.stopAttempts = 0;
      vm.stopDueAt = this.now() + (this.closed ? 0 : (vm.tailSeconds ?? this.config.offloadIdleStopSeconds) * 1000);
      if (this.closed) {
        await this.stopVm(vm);
      } else {
        this.scheduleIdleStop(vm, vm.generation, (vm.tailSeconds ?? this.config.offloadIdleStopSeconds) * 1000);
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
      const response = await this.boat.stop({ sandboxId: vm.sandboxId });
      if (this.ledger) {
        const state = (response as { sandbox?: { state?: string } }).sandbox?.state;
        if (state === "archived" || state === "cancelled") await this.ledger.stopped(vm.sandboxId);
      }
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
