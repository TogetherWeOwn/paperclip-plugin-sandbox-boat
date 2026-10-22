// Budget guard. Before every start (create, fork, resume: each one counts as a
// start, docs.boat.dev/limits) the plugin reads GET /limits once and refuses
// the start when it would pass one of our limits. A refusal is immediate and
// agent-readable; nothing waits for a window to roll.
import type { BoatDriverConfig, BoatSize } from "./config.js";
import { BoatProviderError } from "./errors.js";

export interface BudgetSnapshot {
  accessTier: string | null;
  canStart: boolean;
  startBlockedReason: string | null;
  activeSandboxes: number | null;
  maxActiveSandboxes: number | null;
  startsDayUsed: number | null;
  startsDayLimit: number | null;
  startsHourRemaining: number | null;
  startsMinuteRemaining: number | null;
  computeHoursLeft: number | null;
  trialComputeCapHours: number | null;
  machineTypes: Array<{ type: string; available: boolean; reason: string | null }>;
  trialLine: string | null;
}

export type BudgetLimitName =
  | "boat_cannot_start"
  | "maxActive"
  | "maxStartsPerDay"
  | "boatStartsPerHour"
  | "boatStartsPerMinute"
  | "minComputeHoursLeft"
  | "machineType";

export interface BudgetRefusal {
  limit: BudgetLimitName;
  message: string;
  details: Record<string, unknown>;
}

function n(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** GET /limits is flat in practice; older SDK typings nest some fields under `upgradeEffects`. Read both. */
export function readBudget(response: unknown): BudgetSnapshot {
  const root = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const nested = (root.upgradeEffects && typeof root.upgradeEffects === "object" ? root.upgradeEffects : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: string): unknown => (root[key] !== undefined ? root[key] : nested[key]);
  const pkg = (pick("_package") ?? {}) as Record<string, unknown>;
  const field = (key: string): unknown => (pick(key) !== undefined ? pick(key) : pkg[key]);

  const starts = (field("starts") ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const day = starts.day ?? {};
  const hour = starts.hour ?? {};
  const minute = starts.minute ?? {};

  const trialCap = n(field("trialComputeCapSeconds"));
  const used = n(field("creditUsedSeconds")) ?? 0;
  const balanceSeconds = n(field("creditBalanceSeconds"));
  const trialLeft = trialCap != null && trialCap > 0 ? Math.max(0, trialCap - used) : null;
  let computeSecondsLeft: number | null = trialLeft;
  if (balanceSeconds != null) {
    computeSecondsLeft = computeSecondsLeft == null ? balanceSeconds : Math.min(computeSecondsLeft, balanceSeconds);
  }

  const machineTypesRaw = field("machineTypes");
  const machineTypes = Array.isArray(machineTypesRaw)
    ? machineTypesRaw
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => ({
          type: String(entry.type ?? ""),
          available: entry.available === true,
          reason: s(entry.reason),
        }))
    : [];

  return {
    accessTier: s(field("accessTier")),
    canStart: field("canStart") !== false,
    startBlockedReason: s(field("startBlockedReason")) ?? s(field("blockedReason")),
    activeSandboxes: n(field("activeSandboxes")),
    maxActiveSandboxes: n(field("maxActiveSandboxes")),
    startsDayUsed: n(day.used),
    startsDayLimit: n(day.limit),
    startsHourRemaining: n(hour.remaining),
    startsMinuteRemaining: n(minute.remaining),
    computeHoursLeft: computeSecondsLeft == null ? null : computeSecondsLeft / 3600,
    trialComputeCapHours: trialCap != null && trialCap > 0 ? trialCap / 3600 : null,
    machineTypes,
    trialLine: s(field("trialLine")),
  };
}

export function checkBudget(snapshot: BudgetSnapshot, config: BoatDriverConfig, size: BoatSize): BudgetRefusal | null {
  const nothingStarted = "Nothing was started or billed.";
  if (!snapshot.canStart) {
    return {
      limit: "boat_cannot_start",
      message: `boat says this account cannot start a sandbox now (${snapshot.startBlockedReason ?? "no reason given"}). ${nothingStarted}`,
      details: { startBlockedReason: snapshot.startBlockedReason },
    };
  }
  const active = snapshot.activeSandboxes ?? 0;
  const activeCap = Math.min(config.maxActive, snapshot.maxActiveSandboxes ?? Number.POSITIVE_INFINITY);
  if (active >= activeCap) {
    return {
      limit: "maxActive",
      message: `${active} boat sandboxes are already running and the limit is ${activeCap} (config maxActive=${config.maxActive}, boat plan allows ${snapshot.maxActiveSandboxes ?? "?"}). ${nothingStarted} Retry when a run on another card has finished, or run this card on the local environment.`,
      details: { activeSandboxes: active, maxActive: config.maxActive, boatMaxActive: snapshot.maxActiveSandboxes },
    };
  }
  const dayUsed = snapshot.startsDayUsed ?? 0;
  const dayCap = Math.min(config.maxStartsPerDay, snapshot.startsDayLimit ?? Number.POSITIVE_INFINITY);
  if (dayUsed >= dayCap) {
    return {
      limit: "maxStartsPerDay",
      message: `${dayUsed} sandbox starts (create, fork or resume) in the last 24 hours and the limit is ${dayCap} (config maxStartsPerDay=${config.maxStartsPerDay}, boat plan allows ${snapshot.startsDayLimit ?? "?"}). ${nothingStarted} The window rolls: each start stops counting 24 hours after it happened.`,
      details: { startsDayUsed: dayUsed, maxStartsPerDay: config.maxStartsPerDay, boatStartsPerDay: snapshot.startsDayLimit },
    };
  }
  if (snapshot.startsHourRemaining != null && snapshot.startsHourRemaining <= 0) {
    return {
      limit: "boatStartsPerHour",
      message: `boat's start limit for the last hour is used up. ${nothingStarted} Retry after the hour window rolls.`,
      details: { startsHourRemaining: snapshot.startsHourRemaining },
    };
  }
  if (snapshot.startsMinuteRemaining != null && snapshot.startsMinuteRemaining <= 0) {
    return {
      limit: "boatStartsPerMinute",
      message: `boat's start limit for the last minute is used up. ${nothingStarted} Retry in 60 seconds.`,
      details: { startsMinuteRemaining: snapshot.startsMinuteRemaining },
    };
  }
  if (snapshot.computeHoursLeft != null && snapshot.computeHoursLeft < config.minComputeHoursLeft) {
    return {
      limit: "minComputeHoursLeft",
      message: `only ${snapshot.computeHoursLeft.toFixed(2)} hours of boat compute are left and the reserve is ${config.minComputeHoursLeft} hours (config minComputeHoursLeft). ${nothingStarted} The owner must add time (plan or credit pack) before more boat runs.`,
      details: { computeHoursLeft: snapshot.computeHoursLeft, minComputeHoursLeft: config.minComputeHoursLeft },
    };
  }
  const machine = snapshot.machineTypes.find((entry) => entry.type === size);
  if (machine && !machine.available) {
    return {
      limit: "machineType",
      message: `boat does not allow size ${size} on this account now (${machine.reason ?? "no reason given"}). ${nothingStarted} Use size small or default.`,
      details: { size, reason: machine.reason },
    };
  }
  return null;
}

export class BoatBudgetError extends BoatProviderError {
  readonly limit: BudgetLimitName;

  constructor(refusal: BudgetRefusal) {
    super("BOAT_BUDGET_GUARD", `boat budget guard (${refusal.limit}): ${refusal.message}`, {
      limit: refusal.limit,
      ...refusal.details,
    });
    this.name = "BoatBudgetError";
    this.limit = refusal.limit;
  }
}
