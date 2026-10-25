// Guest enforcement is an opt-in transport port, not a claim that a profile
// name or a host timer proves cgroup delegation / an independent watchdog.
import type { OffloadCommand, OffloadTimers } from "./offload.js";
import { offloadError, type OffloadIdentity } from "./offload-journal.js";

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

export class OffloadLifecycle {
  constructor(private readonly guest: GuestController, private readonly now: () => number,
    private readonly timers: OffloadTimers) {}

  async prepare(sandboxId: string, command: OffloadCommand, base: OffloadIdentity): Promise<ExecutionIdentity> {
    const capabilities = await this.guest.preflight(sandboxId, command);
    if (capabilities.cgroupV2Delegated !== true || capabilities.outsideWatchdogVerified !== true) {
      throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
    }
    const identity = await this.guest.prepare(sandboxId, command);
    if (!identity.guestBootId || identity.guestBootId.startsWith("unverified:")
      || identity.guestBootId !== base.guestBootId || identity.journalGeneration !== base.journalGeneration
      || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId <= 0
      || !identity.cgroupPath.startsWith("/") || identity.cgroupPath === "/"
      || identity.cgroupPath.split("/").some((part) => part === ".." || part === ".")
      || identity.cgroupPath.includes("\0")
      || !Number.isSafeInteger(identity.heartbeatDeadline) || identity.heartbeatDeadline <= this.now()
      || identity.heartbeatDeadline > this.now() + 30_000
      || !Number.isSafeInteger(identity.guestDeadline) || identity.guestDeadline <= this.now()
      || identity.guestDeadline > this.now() + (command.timeoutMs ?? 120_000)) {
      throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    }
    return { ...base, ...identity };
  }

  async run(identity: ExecutionIdentity, command: OffloadCommand,
    transport: (sandboxId: string, command: OffloadCommand, context: OffloadRunContext) => Promise<CommandExit>,
    output: OffloadRunContext["output"]): Promise<CommandExit> {
    // The journal has already durably committed the full identity and both
    // deadlines before this independent watchdog is armed or transport is used.
    const armed = await this.guest.armDeadline(identity.sandboxId, identity);
    if (armed.verified !== true || armed.outsideCommandCgroup !== true) throw offloadError("OFFLOAD_WATCHDOG_UNVERIFIED");
    return await transport(identity.sandboxId, command, { identity: structuredClone(identity), output });
  }
}
