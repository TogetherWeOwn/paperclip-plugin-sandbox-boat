// v1 offload executor: one heavy command on a shared pool VM.
// Design: docs/adr/0001-heavy-command-offload.md (TOG-38023, merged).
// Card: TOG-38024. Test-first: src/offload.test.ts.
//
// Scope: warm pick, resume/create up to maxOffloadVms, FIFO queue, idle stop
// after C with generation-guarded timers, start/compute budget fallback to
// OFFLOAD_UNAVAILABLE, per-command usage + expected-cost log, idempotency by
// commandId. Sweep backstop, sync adapter, cancel/read routes and C=300
// adaptive policy are follow-ups, not in this slice.
import { checkBudget, readBudget } from "./budget.js";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { PRICE_PER_HOUR } from "./size-policy.js";

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

export interface OffloadDeps {
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
  lastActiveAt: number;
  generation: number;
  idleHandle: unknown | null;
}

interface Queued {
  command: OffloadCommand;
  digest: string;
  enqueuedAt: number;
  resolve: (result: OffloadResult | null) => void;
  timerHandle: unknown | null;
}

function digestOf(command: OffloadCommand): string {
  // Stable, secret-free identity for idempotency: same ID + same payload.
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
  private readonly logger: OffloadLogger;
  private readonly now: () => number;
  private readonly timers: OffloadTimers;
  private readonly config: Required<Pick<OffloadExecutorConfig, "maxOffloadVms" | "offloadIdleStopSeconds">> &
    Required<Pick<OffloadExecutorConfig, "queueLimit" | "queueTimeoutMs" | "size" | "maxActive" | "maxStartsPerDay" | "minComputeHoursLeft">>;
  private readonly runCommand: OffloadDeps["runCommand"];
  private readonly pool: PoolVm[] = [];
  private readonly queue: Queued[] = [];
  private readonly journal = new Map<string, { digest: string; result: OffloadResult | null }>();
  private readonly usage: OffloadUsageRow[] = [];
  private admission: Promise<unknown> = Promise.resolve();

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
  }

  getUsage(): OffloadUsageRow[] {
    return [...this.usage];
  }

  async shutdown(): Promise<void> {
    for (const vm of this.pool) {
      if (vm.idleHandle != null) {
        this.timers.clear(vm.idleHandle);
        vm.idleHandle = null;
      }
    }
    for (const entry of this.queue.splice(0)) {
      if (entry.timerHandle != null) this.timers.clear(entry.timerHandle);
      entry.resolve({ status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: entry.command.commandId, remoteStarted: false, fallbackSafe: true, reason: "executor shutdown" });
    }
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
      // Same ID admitted but not yet finished: fall through and let the
      // queue/admission serialize it; the second caller waits its turn but
      // the journal prevents a double spawn by returning the first result.
    } else {
      // Persist intent before any external effect.
      this.journal.set(command.commandId, { digest, result: null });
    }

    const enqueuedAt = this.now();
    for (;;) {
      const claimed = await this.withAdmission(() => this.claimSlot(command));
      if (claimed.kind === "run") {
        const queueWaitMs = this.now() - enqueuedAt;
        const result = await this.runOnVm(claimed.vm, command, claimed.warm, queueWaitMs);
        // If this commandId was already completed by a racing duplicate,
        // prefer the journaled result to avoid a double record.
        const journaled = this.journal.get(command.commandId);
        if (journaled?.result && journaled.result !== result) return journaled.result;
        return result;
      }
      if (claimed.kind === "unavailable") {
        const result: OffloadResult = { status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: command.commandId, remoteStarted: false, fallbackSafe: true, reason: claimed.reason };
        this.journal.set(command.commandId, { digest, result });
        return result;
      }
      // Queued: wait until dispatch or timeout.
      const result = await claimed.wait;
      if (result) return result;
      // Timeout already resolved as unavailable inside the waiter.
      const journaled = this.journal.get(command.commandId);
      if (journaled?.result) return journaled.result;
      // Dispatched: loop to claim the reserved VM.
    }
  }

  private async claimSlot(
    command: OffloadCommand,
  ): Promise<{ kind: "run"; vm: PoolVm; warm: OffloadWarm } | { kind: "unavailable"; reason: string } | { kind: "queued"; wait: Promise<OffloadResult | null> }> {
    // Warmest idle first (running, not stopped).
    let best: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || vm.stopped) continue;
      if (!best || vm.lastActiveAt > best.lastActiveAt) best = vm;
    }
    if (best) {
      best.busy = true;
      best.generation += 1;
      if (best.idleHandle != null) {
        this.timers.clear(best.idleHandle);
        best.idleHandle = null;
      }
      return { kind: "run", vm: best, warm: "warm" };
    }
    // Most recently stopped compatible VM next.
    let stopped: PoolVm | null = null;
    for (const vm of this.pool) {
      if (vm.busy || !vm.stopped) continue;
      if (!stopped || vm.lastActiveAt > stopped.lastActiveAt) stopped = vm;
    }
    if (stopped) {
      const refusal = await this.budgetRefusal();
      if (refusal) return { kind: "unavailable", reason: refusal };
      stopped.busy = true;
      stopped.generation += 1;
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
      const placeholder: PoolVm = { sandboxId: "", busy: true, stopped: false, lastActiveAt: this.now(), generation: 0, idleHandle: null };
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
    let resolveWait!: (result: OffloadResult | null) => void;
    const wait = new Promise<OffloadResult | null>((resolve) => {
      resolveWait = resolve;
    });
    const entry: Queued = { command, digest: digestOf(command), enqueuedAt: this.now(), resolve: resolveWait, timerHandle: null };
    // Queue expiry compare-and-transitions under the admission lock: only the
    // expiry or the dispatch wins.
    entry.timerHandle = this.timers.set(() => {
      void this.withAdmission(async () => {
        const at = this.queue.indexOf(entry);
        if (at < 0) return;
        this.queue.splice(at, 1);
        const result: OffloadResult = { status: "unavailable", code: "OFFLOAD_UNAVAILABLE", commandId: command.commandId, remoteStarted: false, fallbackSafe: true, reason: `queue timeout after ${timeoutMs} ms` };
        this.journal.set(command.commandId, { digest: entry.digest, result });
        entry.resolve(result);
      });
    }, timeoutMs);
    this.queue.push(entry);
    return { kind: "queued", wait };
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
    let exitCode = 1;
    let seconds = 0;
    try {
      const outcome = await this.runCommand(vm.sandboxId, command);
      exitCode = outcome.exitCode;
      seconds = outcome.seconds;
    } finally {
      await this.releaseVm(vm);
    }
    const dollars = (seconds / 3600) * PRICE_PER_HOUR[this.config.size];
    const result: OffloadResult = { status: "completed", commandId: command.commandId, sandboxId: vm.sandboxId, warm, queueWaitMs, exitCode, seconds, dollars };
    // Journal the terminal result; same ID returns the same command.
    const seen = this.journal.get(command.commandId);
    if (seen && !seen.result) this.journal.set(command.commandId, { digest: seen.digest, result });
    this.usage.push({ commandId: command.commandId, runId: command.runId, cardId: command.cardId, repoId: command.repoId, sandboxId: vm.sandboxId, warm, queueWaitMs, seconds, dollars, exitCode, at: new Date(this.now()).toISOString() });
    // Sanitized expected-cost line: identity + accounting only, never argv/env.
    this.logger.info(`boat offload expected-cost ${JSON.stringify({ commandId: command.commandId, repoId: command.repoId, size: this.config.size, warm, queueWaitMs, seconds, dollars: Number(dollars.toFixed(6)) })}`, {
      commandId: command.commandId,
      repoId: command.repoId,
      sandboxId: vm.sandboxId,
      warm,
      queueWaitMs,
      seconds,
      dollars,
    });
    return result;
  }

  private async releaseVm(vm: PoolVm): Promise<void> {
    await this.withAdmission(async () => {
      const next = this.queue.shift();
      if (next) {
        if (next.timerHandle != null) {
          this.timers.clear(next.timerHandle);
          next.timerHandle = null;
        }
        // Hand the still-busy VM to the next waiter: resolve with null so it
        // loops and claims it as the warmest idle-turned-busy. Mark idle first
        // so the claim finds it, then the claim re-marks busy.
        vm.busy = false;
        vm.lastActiveAt = this.now();
        // Dispatch wins the generation: cancel any pending idle timer (there
        // is none yet, the VM was busy) and let the claim bump the generation.
        next.resolve(null);
        return;
      }
      vm.busy = false;
      vm.lastActiveAt = this.now();
      vm.generation += 1;
      const generation = vm.generation;
      const delayMs = this.config.offloadIdleStopSeconds * 1000;
      vm.idleHandle = this.timers.set(() => {
        void this.withAdmission(async () => {
          if (vm.generation !== generation || vm.busy || vm.stopped) return;
          vm.idleHandle = null;
          try {
            await this.boat.stop({ sandboxId: vm.sandboxId });
          } catch {
            // Leave the VM idle; the sweep is the backstop.
            return;
          }
          vm.stopped = true;
          vm.lastActiveAt = this.now();
        });
      }, delayMs);
    });
  }
}
