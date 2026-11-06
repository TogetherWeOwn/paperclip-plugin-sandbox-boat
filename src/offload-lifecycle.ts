// Guest enforcement is an opt-in transport port, not a claim that a profile
// name or a host timer proves cgroup delegation / an independent watchdog.
import type { OffloadCommand, OffloadTimers } from "./offload.js";
import { commandKey, offloadError, validGuestIdentity, validPreStartDetail, type OffloadIdentity } from "./offload-journal.js";

export interface GuestIdentity {
  guestBootId: string;
  processGroupId: number;
  cgroupPath: string;
  journalGeneration: number;
  heartbeatDeadline: number;
  guestDeadline: number;
  /**
   * Guest clock (epoch ms) when the prepare response was produced. The host
   * maps guest-clock absolutes onto its own clock with this offset and never
   * compares the two clocks' absolutes directly. Absent (older fixtures):
   * the clocks are assumed aligned.
   */
  guestNow?: number;
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
    /** Allowlisted sub-cause token when not eligible (guest-probe step,
     * RPC transport failure, …). Server-log diagnosis only; the
     * client-facing code stays OFFLOAD_GUEST_INELIGIBLE. */
    ineligibleReason?: string;
    /** Session refreshes the bounded delegation wait attempted (server log
     * only, a count, never guest bytes). Absent when none ran. */
    delegationRefreshes?: number;
    /** Of those refreshes, how many reopened and re-ran the probe; the rest
     * failed to reconnect. Server log only. Absent when none ran. */
    delegationReprobes?: number;
  }>;
  prepare(sandboxId: string, command: OffloadCommand): Promise<GuestIdentity>;
  armDeadline(sandboxId: string, identity: GuestIdentity): Promise<{ verified: boolean; outsideCommandCgroup: boolean }>;
  inspect(sandboxId: string, identity: GuestIdentity): Promise<{
    identity: GuestIdentity; populated: boolean; receipt: string;
  }>;
  term(sandboxId: string, identity: GuestIdentity): Promise<void>;
  kill(sandboxId: string, identity: GuestIdentity): Promise<void>;
  verifyEmpty(sandboxId: string, identity: GuestIdentity): Promise<boolean>;
  /** Renew the independent guest watchdog too, not only the host timer. */
  heartbeat?(sandboxId: string, identity: GuestIdentity): Promise<void>;
}

interface ActiveGuest {
  identity: ExecutionIdentity;
  interestTimer: unknown | null;
  deadlineTimer: unknown | null;
  reason: string | null;
  transportStarted: boolean;
  cleanup: Promise<void> | null;
}
const OWNERSHIP = ["guestBootId", "processGroupId", "cgroupPath", "journalGeneration"] as const;

export class OffloadLifecycle {
  private readonly active = new Map<string, ActiveGuest>();
  // An outside watchdog outlives a completed leader, and its callback can be
  // delayed past its nominal deadline. Without explicit revocation evidence,
  // never recycle a prepared path in the same VM boot for this worker lifetime.
  private readonly watchdogPaths = new Set<string>();
  constructor(private readonly guest: GuestController, private readonly now: () => number,
    private readonly timers: OffloadTimers) {}

  async prepare(sandboxId: string, command: OffloadCommand, base: OffloadIdentity): Promise<ExecutionIdentity> {
    const capabilities = await this.guest.preflight(sandboxId, command);
    if (capabilities.cgroupV2Delegated !== true || capabilities.outsideWatchdogVerified !== true) {
      // The client-facing code is unchanged; the detail token only lets the
      // server log separate a guest-reported refusal (and which probe step)
      // from a preflight RPC transport failure. A controller that names no
      // sub-cause still says which capability flag was not true.
      const detail = validPreStartDetail(capabilities.ineligibleReason)
        ?? (capabilities.cgroupV2Delegated !== true && capabilities.outsideWatchdogVerified !== true
          ? "cgroup_and_watchdog_false"
          : capabilities.cgroupV2Delegated !== true ? "cgroup_not_delegated" : "watchdog_not_verified");
      const refreshes = capabilities.delegationRefreshes;
      const reprobes = capabilities.delegationReprobes;
      throw Object.assign(offloadError("OFFLOAD_GUEST_INELIGIBLE", detail),
        Number.isSafeInteger(refreshes) ? { refreshes } : {},
        Number.isSafeInteger(reprobes) ? { reprobes } : {});
    }
    const sentAt = this.now();
    const identity = await this.guest.prepare(sandboxId, command);
    // The guest reports absolutes on its own clock. Map them onto the host
    // clock with the pre-send host time: the supervisor stamps guestNow when
    // it creates the child, which can be no earlier than the send, so
    // send-based mapping is conservative where receive-based mapping would
    // shift an already-expired guest deadline into the host future. The
    // stored identity below is host-clock throughout.
    const guestNow = Number.isSafeInteger(identity.guestNow) ? (identity.guestNow as number) : sentAt;
    const skew = guestNow - sentAt;
    const heartbeatDeadline = identity.heartbeatDeadline - skew;
    const guestDeadline = identity.guestDeadline - skew;
    if (!validGuestIdentity(identity) || identity.guestBootId.startsWith("unverified:")
      || identity.guestBootId !== base.guestBootId || identity.journalGeneration !== base.journalGeneration
      || !(heartbeatDeadline > this.now()) || heartbeatDeadline > this.now() + 30_000
      || !(guestDeadline > this.now()) || guestDeadline > this.now() + (command.timeoutMs ?? 120_000)) {
      throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    }
    const path = JSON.stringify([sandboxId, identity.guestBootId, identity.cgroupPath]);
    if (this.watchdogPaths.has(path)) throw offloadError("OFFLOAD_GUEST_CGROUP_REUSED");
    this.watchdogPaths.add(path);
    // Guest replies may contain extra fields at runtime. Only the six guest
    // fields can cross this boundary; host command and VM bindings cannot.
    const full: ExecutionIdentity = { ...base, guestBootId: identity.guestBootId,
      processGroupId: identity.processGroupId, cgroupPath: identity.cgroupPath,
      journalGeneration: identity.journalGeneration, heartbeatDeadline, guestDeadline };
    // Register before the journal awaits its starting commit, so a cancellation
    // winning that commit/run gap cannot disappear before run() registers it.
    this.active.set(commandKey(full), { identity: structuredClone(full), interestTimer: null,
      deadlineTimer: null, reason: null, transportStarted: false, cleanup: null });
    return full;
  }

  remember(identity: OffloadIdentity): void {
    if (!validGuestIdentity(identity)) throw offloadError("OFFLOAD_GUEST_OWNERSHIP_UNKNOWN");
    this.watchdogPaths.add(JSON.stringify([identity.sandboxId, identity.guestBootId, identity.cgroupPath]));
  }

  // Recovery is observational: a running receipt is not authority to replay,
  // signal or release a command. Remember its watchdog path across restarts too.
  async observe(identity: OffloadIdentity): Promise<{ populated: boolean; receipt: string }> {
    this.remember(identity);
    if (!validGuestIdentity(identity)) throw offloadError("OFFLOAD_GUEST_OWNERSHIP_UNKNOWN");
    const observed = await this.guest.inspect(identity.sandboxId, structuredClone(identity));
    if (!observed.identity || !OWNERSHIP.every((key) => observed.identity[key] === identity[key])
      || typeof observed.populated !== "boolean" || !["running", "completed", "never_started"].includes(observed.receipt)
      || observed.receipt === "never_started" && observed.populated) {
      throw offloadError("OFFLOAD_GUEST_OWNERSHIP_UNKNOWN");
    }
    return observed;
  }

  discard(identity: OffloadIdentity): void {
    const key = commandKey(identity);
    const entry = this.active.get(key);
    if (!entry || !this.matches(entry, identity as GuestIdentity)) return;
    this.clearTimers(entry);
    this.active.delete(key);
  }

  /** Forget every watchdog path of a VM that stopped or was released: its boot
   * id changes on resume, so those paths can never match a new prepare. */
  releaseSandbox(sandboxId: string): void {
    for (const path of this.watchdogPaths) {
      try {
        const [sandbox] = JSON.parse(path) as [string];
        if (sandbox === sandboxId) this.watchdogPaths.delete(path);
      } catch {
        this.watchdogPaths.delete(path);
      }
    }
  }

  private expire(entry: ActiveGuest): void {
    if (this.now() >= entry.identity.guestDeadline) entry.reason ??= "execution_timeout";
    else if (this.now() >= entry.identity.heartbeatDeadline) entry.reason ??= "interest_expired";
  }

  async run(identity: ExecutionIdentity, command: OffloadCommand,
    transport: (sandboxId: string, command: OffloadCommand, context: OffloadRunContext) => Promise<CommandExit>,
    output: OffloadRunContext["output"]): Promise<CommandExit> {
    const entry = this.active.get(commandKey(identity));
    if (!entry || !this.matches(entry, identity)) throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    try {
      // Persistence and watchdog RPCs can outlast either deadline. A timer
      // scheduled for zero milliseconds is not a synchronous spawn fence.
      this.expire(entry);
      if (entry.reason === null) {
        const armed = await this.guest.armDeadline(identity.sandboxId, structuredClone(identity));
        if (armed.verified !== true || armed.outsideCommandCgroup !== true) throw offloadError("OFFLOAD_WATCHDOG_UNVERIFIED");
        this.expire(entry);
      }
      let raw: CommandExit = { exitCode: 130, seconds: 0 };
      if (entry.reason === null) {
        this.scheduleInterest(entry);
        entry.deadlineTimer = this.timers.set(() => {
          void this.cancel(identity, "execution_timeout").catch(() => {});
        }, Math.max(0, identity.guestDeadline - this.now()));
        entry.transportStarted = true;
        // Rejecting transport (including output-consumer errors) does not prove
        // the guest exited. Always join subtree cleanup before unwinding it.
        try { raw = await transport(identity.sandboxId, command, { identity: structuredClone(identity), output }); }
        finally { await this.clean(entry); }
      } else {
        await this.clean(entry);
      }
      // The transport result is guest-controlled bytes: validate before use,
      // and take cancelled/timedOut only from host state, never from the
      // guest. A defensive return from named fields (no ...raw spread) keeps
      // even a compromised transport out of the journal and ledger.
      const guestExit = (raw as { exitCode?: unknown } | null)?.exitCode;
      const guestSeconds = (raw as { seconds?: unknown } | null)?.seconds;
      if (!Number.isInteger(guestExit) || (guestExit as number) < 0 || (guestExit as number) > 255
        || typeof guestSeconds !== "number" || !Number.isFinite(guestSeconds) || guestSeconds < 0) {
        throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      }
      const timedOut = entry.reason === "execution_timeout" || this.now() >= identity.guestDeadline;
      return { exitCode: timedOut ? 124 : entry.reason !== null ? 130 : (guestExit as number), seconds: guestSeconds,
        ...(entry.reason !== null ? { cancelled: !timedOut } : {}), ...(timedOut ? { timedOut: true } : {}) };
    } finally {
      this.discard(identity);
    }
  }

  async heartbeat(identity: OffloadIdentity): Promise<void> {
    const entry = this.active.get(commandKey(identity));
    if (!entry || entry.reason || entry.cleanup || this.now() >= entry.identity.heartbeatDeadline
      || !this.matches(entry, identity as GuestIdentity)) return;
    // Host-side deadline from the host clock taken just before the send; the
    // guest renews its own clock-side deadline from the renewMs duration.
    const sentAt = this.now();
    if (this.guest.heartbeat) await this.guest.heartbeat(identity.sandboxId, identity as GuestIdentity);
    // A cancellation/timeout can win while the renewal crosses SSH.
    if (entry.reason || entry.cleanup || this.now() >= entry.identity.heartbeatDeadline) return;
    entry.identity.heartbeatDeadline = sentAt + 30_000;
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
      const neverStarted = !entry.transportStarted && observed.receipt === "never_started" && observed.populated === false;
      if (!this.matches(entry, observed.identity) || typeof observed.populated !== "boolean"
        || (!neverStarted && !["running", "completed"].includes(observed.receipt))) {
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
