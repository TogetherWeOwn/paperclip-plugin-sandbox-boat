// Guest enforcement is an opt-in transport port, not a claim that a profile
// name or a host timer proves cgroup delegation / an independent watchdog.
import type { OffloadCommand, OffloadTimers } from "./offload.js";
import { commandKey, offloadError, validGuestIdentity, type OffloadIdentity } from "./offload-journal.js";

export interface GuestIdentity {
  guestBootId: string;
  processGroupId: number;
  cgroupPath: string;
  journalGeneration: number;
  heartbeatDeadline: number;
  guestDeadline: number;
}
export type ExecutionIdentity = OffloadIdentity & GuestIdentity;
export interface OffloadRunContext {
  identity: ExecutionIdentity;
  output(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void>;
}
export interface CommandExit {
  exitCode: number;
  seconds: number;
  cancelled?: boolean;
  timedOut?: boolean;
}
export interface GuestController {
  preflight(sandboxId: string, command: OffloadCommand): Promise<{
    cgroupV2Delegated: boolean | null; outsideWatchdogVerified: boolean | null;
  }>;
  prepare(sandboxId: string, command: OffloadCommand): Promise<GuestIdentity>;
  armDeadline(sandboxId: string, identity: GuestIdentity): Promise<{ verified: boolean; outsideCommandCgroup: boolean }>;
  inspect(sandboxId: string, identity: GuestIdentity): Promise<{
    identity: GuestIdentity; populated: boolean; receipt: string;
  }>;
  term(sandboxId: string, identity: GuestIdentity): Promise<void>;
  kill(sandboxId: string, identity: GuestIdentity): Promise<void>;
  verifyEmpty(sandboxId: string, identity: GuestIdentity): Promise<boolean>;
}

interface ActiveGuest {
  identity: ExecutionIdentity;
  interestTimer: unknown | null;
  deadlineTimer: unknown | null;
  reason: string | null;
  cleanup: Promise<void> | null;
}
const OWNERSHIP = ["guestBootId", "processGroupId", "cgroupPath", "journalGeneration"] as const;

export class OffloadLifecycle {
  private readonly active = new Map<string, ActiveGuest>();
  // An outside watchdog outlives a completed leader. Never recycle its cgroup
  // path for another command while that old deadline can still fire.
  private readonly watchdogPaths = new Map<string, number>();
  constructor(private readonly guest: GuestController, private readonly now: () => number,
    private readonly timers: OffloadTimers) {}

  async prepare(sandboxId: string, command: OffloadCommand, base: OffloadIdentity): Promise<ExecutionIdentity> {
    const capabilities = await this.guest.preflight(sandboxId, command);
    if (capabilities.cgroupV2Delegated !== true || capabilities.outsideWatchdogVerified !== true) {
      throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
    }
    const identity = await this.guest.prepare(sandboxId, command);
    if (!validGuestIdentity(identity) || identity.guestBootId.startsWith("unverified:")
      || identity.guestBootId !== base.guestBootId || identity.journalGeneration !== base.journalGeneration
      || identity.heartbeatDeadline <= this.now() || identity.heartbeatDeadline > this.now() + 30_000
      || identity.guestDeadline <= this.now() || identity.guestDeadline > this.now() + (command.timeoutMs ?? 120_000)) {
      throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    }
    for (const [path, deadline] of this.watchdogPaths) if (deadline <= this.now()) this.watchdogPaths.delete(path);
    const path = JSON.stringify([sandboxId, identity.guestBootId, identity.cgroupPath]);
    if (this.watchdogPaths.has(path)) throw offloadError("OFFLOAD_GUEST_CGROUP_REUSED");
    this.watchdogPaths.set(path, identity.guestDeadline);
    return { ...base, ...identity };
  }

  async run(identity: ExecutionIdentity, command: OffloadCommand,
    transport: (sandboxId: string, command: OffloadCommand, context: OffloadRunContext) => Promise<CommandExit>,
    output: OffloadRunContext["output"]): Promise<CommandExit> {
    // The journal has already durably committed the full identity and both
    // deadlines before this independent watchdog is armed or transport is used.
    const entry: ActiveGuest = { identity: structuredClone(identity), interestTimer: null,
      deadlineTimer: null, reason: null, cleanup: null };
    this.active.set(commandKey(identity), entry);
    const armed = await this.guest.armDeadline(identity.sandboxId, structuredClone(identity));
    if (armed.verified !== true || armed.outsideCommandCgroup !== true) throw offloadError("OFFLOAD_WATCHDOG_UNVERIFIED");
    this.scheduleInterest(entry);
    entry.deadlineTimer = this.timers.set(() => {
      void this.cancel(identity, "execution_timeout").catch(() => {});
    }, Math.max(0, identity.guestDeadline - this.now()));
    const raw = entry.reason ? { exitCode: 130, seconds: 0 }
      : await transport(identity.sandboxId, command, { identity: structuredClone(identity), output });
    await this.clean(entry);
    this.clearTimers(entry);
    this.active.delete(commandKey(identity));
    const timedOut = entry.reason === "execution_timeout" || this.now() >= identity.guestDeadline;
    return { ...raw, exitCode: timedOut ? 124 : entry.reason ? 130 : raw.exitCode,
      ...(entry.reason ? { cancelled: !timedOut } : {}), ...(timedOut ? { timedOut: true } : {}) };
  }

  heartbeat(identity: OffloadIdentity): void {
    const entry = this.active.get(commandKey(identity));
    if (!entry || entry.reason || entry.cleanup || this.now() >= entry.identity.heartbeatDeadline
      || !this.matches(entry, identity as GuestIdentity)) return;
    entry.identity.heartbeatDeadline = (identity as GuestIdentity).heartbeatDeadline;
    this.scheduleInterest(entry);
  }

  async cancel(identity: OffloadIdentity, reason: string): Promise<void> {
    const entry = this.active.get(commandKey(identity));
    if (!entry || !this.matches(entry, identity as GuestIdentity)) return;
    entry.reason ??= reason;
    this.clearTimers(entry);
    await this.clean(entry);
  }

  private scheduleInterest(entry: ActiveGuest): void {
    if (entry.interestTimer !== null) this.timers.clear(entry.interestTimer);
    entry.interestTimer = this.timers.set(() => {
      void this.cancel(entry.identity, "interest_expired").catch(() => {});
    }, Math.max(0, entry.identity.heartbeatDeadline - this.now()));
  }

  private clearTimers(entry: ActiveGuest): void {
    if (entry.interestTimer !== null) this.timers.clear(entry.interestTimer);
    if (entry.deadlineTimer !== null) this.timers.clear(entry.deadlineTimer);
    entry.interestTimer = entry.deadlineTimer = null;
  }

  private matches(entry: ActiveGuest, actual: GuestIdentity): boolean {
    return !!actual && OWNERSHIP.every((key) => actual[key] === entry.identity[key]);
  }

  private clean(entry: ActiveGuest): Promise<void> {
    // All exit/cancel/deadline paths join one cleanup. A rejected cleanup stays
    // rejected: a second request cannot retry signals or clear the quarantine.
    if (!entry.cleanup) {
      entry.cleanup = this.cleanTree(entry).catch((error: unknown) => {
        this.clearTimers(entry);
        throw error;
      });
    }
    return entry.cleanup;
  }

  private async cleanTree(entry: ActiveGuest): Promise<void> {
    const identity = entry.identity;
    const inspect = async () => {
      const observed = await this.guest.inspect(identity.sandboxId, structuredClone(identity));
      if (!this.matches(entry, observed.identity) || !["running", "completed"].includes(observed.receipt)) {
        throw offloadError("OFFLOAD_GUEST_OWNERSHIP_UNKNOWN");
      }
      return observed;
    };
    const observed = await inspect();
    if (observed.populated) {
      await this.guest.term(identity.sandboxId, structuredClone(identity));
      await new Promise<void>((resolve) => { this.timers.set(resolve, 5_000); });
      // The VM may have rebooted or the reservation changed during the grace
      // interval. Never send cgroup.kill using an old observation.
      await inspect();
      await this.guest.kill(identity.sandboxId, structuredClone(identity));
    }
    if (await this.guest.verifyEmpty(identity.sandboxId, structuredClone(identity)) !== true) {
      throw offloadError("OFFLOAD_GUEST_NOT_EMPTY");
    }
  }
}
