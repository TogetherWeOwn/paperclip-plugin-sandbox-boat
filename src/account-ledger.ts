// One authoritative worker writes this instance-scoped account journal. The
// mutex fences pools and whole-run consumers, not unrelated provider clients.
import { createHash, randomUUID } from "node:crypto";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { BoatProviderError, describeBoatError } from "./errors.js";
import type { StateClientLike } from "./state.js";
import { BoatBudgetError, checkBudget, readBudget, readIncludedAllowance } from "./budget.js";
import type { BudgetLimitName } from "./budget.js";

const WINDOWS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
type Window = keyof typeof WINDOWS;
// @boatdev/sdk 1.10 SandboxUsageResponse.billingMultiplier: seconds already
// include this multiplier. Historical audit version, not re-audited for the
// pinned 1.13.0. Never infer it from wall time or apply it twice.
const WEIGHT: Record<BoatSize, number> = { small: 0.5, default: 1, large: 2, xlarge: 50 / 9 };
/**
 * Stale-hold margin: a start whose provider TTL plus this margin has passed
 * cannot still be running (boat auto-stops it), so an unsettled intent is
 * retired instead of holding active capacity forever.
 */
const STALE_HOLD_MARGIN_MS = 10 * 60_000;
/**
 * Stop-observation grace: terminal receipts and open tails are clamped to the
 * funded tail plus this. The provider TTL ends the VM by then, so anything
 * later is stop-observation lag, not billed VM time.
 */
const STOP_OBSERVE_GRACE_S = 300;
const locks = new Map<string, Promise<unknown>>();

export interface PaidInterval {
  since: string;
  until: string;
  phase: "command" | "idle_tail" | "overhead";
}
export interface AccountUsageRow {
  /** Opaque credential-group binding within the conservatively shared account. */
  providerScope?: string;
  usageRecordId: string;
  queueWaitMs?: number;
  warm?: "warm" | "cold";
  exitCode?: number;
  outcome?: "completed" | "unknown";
  expectedSeconds?: number;
  expectedDollars?: number;
  companyId?: string;
  profileId?: string;
  payloadDigest?: string;
  poolId: string;
  kind: "command" | "failed_start" | "aborted_start" | "overhead";
  commandId: string | null;
  runId: string | null;
  cardId: string | null;
  repoId: string | null;
  sandboxId: string | null;
  seconds: number;
  dollars: number;
  meterProvenance: "estimate" | "provider" | "pending";
  observedStartsDelta: number | null;
  intervals: PaidInterval[];
  // Open tails are finalized at the next reservation or a terminal receipt.
  tailSince: number | null;
  stopRequestedAt?: number | null;
  stoppedAt?: number | null;
  stopLagMs?: number | null;
  // Persist the intended deadline: crash/scheduling delay is part of stop lag.
  stopDueAt?: number | null;
}
interface StartWindow { used: number; limit: number; remaining: number; resetAt: number | null }
interface Limits {
  at: number;
  active: number;
  activeCap: number;
  canStart: boolean;
  available: number;
  used: number;
  includedHours: number;
  periodEndMs: number;
  nextStartDollars: number;
  windows: Record<Window, StartWindow | null>;
  sizes: Array<{ type: string; available: boolean }>;
}
interface Intent {
  providerScope?: string;
  id: string;
  poolId: string | null;
  sandboxId: string | null;
  operation: "create" | "resume" | "warm";
  at: number;
  settledAt: number | null;
  status: "intent" | "running" | "stopped" | "rejected" | "ambiguous";
  active: boolean;
  activeReflected: boolean;
  starts: Record<Window, { reflected: boolean; expiresAt: number }>;
  compute: number;
  computeReflected: number;
  size: BoatSize;
  jobSeconds: number;
  tailSeconds: number;
  /** Provider TTL funded for this start; bounds the hold when the effect is ambiguous. */
  ttlSeconds: number;
  reserveSeconds: number;
  endedAt: number | null;
  usageId: string | null;
}
interface AccountDoc {
  version: 1;
  observation: Limits | null;
  intents: Intent[];
  usage: AccountUsageRow[];
  countedResumeUntil: number | null;
  reconcileCursor?: number;
  providerObservations?: Record<string, Limits>;
  providerCursors?: Record<string, number>;
  observationOwner?: string;
}
export interface AdmissionRequest {
  operation: Intent["operation"];
  allowCachedLimits?: boolean;
  sandboxId?: string;
  poolId?: string;
  size: BoatSize;
  jobSeconds: number;
  tailSeconds: number;
  maxActive: number;
  maxStartsPerDay: number;
  minComputeHoursLeft: number;
  command?: { commandId: string; runId: string; cardId: string; repoId: string; companyId?: string; profileId?: string; payloadDigest?: string };
  /** Monthly offload VM-hour cap: enforced atomically with admission inside the ledger lock. */
  monthlyCap?: { companyId: string; nowMs: number; capHours: number };
}
export interface AccountReservation { id: string; tailSeconds: number; at: number; periodEndMs?: number }

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("limits unreadable: invalid numeric capacity");
  return value;
}
function date(value: unknown): number | null {
  if (value == null) return null;
  const result = new Date(value as string).getTime();
  if (!Number.isFinite(result)) throw new Error("limits unreadable: invalid reset metadata");
  return result;
}
function parseLimits(raw: unknown, at: number): Limits {
  const root = raw as Record<string, unknown> | null;
  if (!root || root.ok !== true) throw new Error("limits unreadable: invalid response");
  const nested = (root.upgradeEffects ?? {}) as Record<string, unknown>;
  const pkg = (root._package ?? nested._package ?? {}) as Record<string, unknown>;
  const field = (key: string) => root[key] !== undefined ? root[key] : nested[key] !== undefined ? nested[key] : pkg[key];
  const included = readIncludedAllowance(field("planIncluded"));
  if (!included || included.periodEndMs <= at) throw new Error("limits unreadable: missing current included allowance");
  const available = included.remaining * 3600;
  const used = (included.hours - included.remaining) * 3600;
  const nextStartDollars = number(field("nextStartDollars"));
  const starts = field("starts") as Record<string, unknown> | undefined;
  if (!starts || typeof starts.unlimited !== "boolean" || typeof field("canStart") !== "boolean") throw new Error("limits unreadable: missing start capacity");
  const windows = {} as Limits["windows"];
  for (const name of Object.keys(WINDOWS) as Window[]) {
    const window = starts[name] as Record<string, unknown> | null;
    if (window == null && starts.unlimited) windows[name] = null;
    else if (window) windows[name] = { used: number(window.used), limit: number(window.limit), remaining: number(window.remaining), resetAt: date(window.resetAt) };
    else throw new Error("limits unreadable: missing start window");
  }
  const sizes = field("machineTypes");
  if (!Array.isArray(sizes)) throw new Error("limits unreadable: missing machine types");
  return { at, active: number(field("activeSandboxes")), activeCap: number(field("maxActiveSandboxes")), canStart: field("canStart") === true,
    available, used, includedHours: included.hours, periodEndMs: included.periodEndMs, nextStartDollars, windows, sizes: sizes as Limits["sizes"] };
}

async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider read timed out after 3 seconds")), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Month-to-date tracked VM seconds for one company, clamped to the UTC month. */
function monthUsageSeconds(doc: AccountDoc, companyId: string, nowMs: number): number {
  const at = new Date(nowMs);
  const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  let totalMs = 0;
  for (const row of doc.usage) {
    if (row.companyId !== companyId) continue;
    for (const interval of row.intervals) {
      const since = Date.parse(interval.since);
      const until = Date.parse(interval.until);
      if (!Number.isFinite(since) || !Number.isFinite(until)) continue;
      totalMs += Math.max(0, Math.min(until, nowMs) - Math.max(since, monthStart));
    }
    if (row.tailSince != null && Number.isFinite(row.tailSince)) {
      // An open tail bills at most its funded tail plus grace: the provider
      // TTL stops the VM by then, so a tail still open days later is an
      // unreconciled receipt, not VM time. Rows without a known intent keep
      // the full count (fail closed) rather than assuming a bound. The bounded
      // end is intersected with the month, so a tail that expired last month
      // charges this month only for the part of its bound inside it (usually
      // nothing).
      const intent = doc.intents.find((i) => i.usageId != null && i.usageId === row.usageRecordId);
      const fundedTailMs = intent == null || !Number.isFinite(intent.tailSeconds)
        ? Infinity : (intent.tailSeconds + STOP_OBSERVE_GRACE_S) * 1000;
      const boundedEnd = Math.min(nowMs, row.tailSince + fundedTailMs);
      totalMs += Math.max(0, boundedEnd - Math.max(row.tailSince, monthStart));
    }
  }
  return totalMs / 1000;
}

/**
 * Reserved envelopes for one company's commands whose time is not yet in
 * monthUsageSeconds: pending starts and started-but-unfinished commands. Once
 * finished()/terminal() record an interval or open tail, the row's own time
 * counts instead, so nothing is counted twice. An ambiguous start or finish
 * records elapsed time while the VM may still run, so the rest of its
 * envelope stays held until terminal() resolves it.
 */
function pendingCapSeconds(doc: AccountDoc, companyId: string): number {
  const byUsage = new Map(doc.usage.map((row) => [row.usageRecordId, row]));
  let total = 0;
  for (const intent of doc.intents) {
    if (intent.status === "rejected" || intent.status === "stopped") continue;
    const row = intent.usageId ? byUsage.get(intent.usageId) : undefined;
    if (row?.companyId !== companyId) continue;
    const envelope = intent.jobSeconds + intent.tailSeconds;
    if (intent.status === "ambiguous") {
      const recordedMs = row.intervals.reduce((sum, i) => sum + Math.max(0, Date.parse(i.until) - Date.parse(i.since)), 0);
      total += Math.max(0, envelope - (Number.isFinite(recordedMs) ? recordedMs : 0) / 1000);
      continue;
    }
    if (row.intervals.length > 0 || row.tailSince != null) continue;
    total += envelope;
  }
  return total;
}

/** Only explicit provider refusals prove that a mutation never took effect. */
export async function definitiveStartRejection(error: unknown): Promise<boolean> {
  const info = await describeBoatError(error);
  if (["idempotency_in_progress", "sandbox_resuming", "sandbox_securing", "sandbox_starting"].includes(info.code ?? "")) return false;
  if (info.status === 503 && ["no_ready_machine", "out_of_capacity"].includes(info.code ?? "")) return true;
  return info.status != null && [400, 401, 403, 404, 409, 422, 429].includes(info.status);
}

export class AccountLedger {
  private readonly key: { scopeKind: "instance"; namespace: string; stateKey: string };
  private rows: AccountUsageRow[] = [];
  constructor(private readonly state: StateClientLike, private readonly accountId: string, private readonly now: () => number,
    private readonly providerScope?: string) {
    this.key = { scopeKind: "instance", namespace: "boat-account", stateKey: createHash("sha256").update(accountId).digest("hex") };
  }

  // An unscoped caller explicitly supplies one provider-account identity (e.g.
  // an offload pool). Managers additionally bind receipts/counter deltas to the
  // credential group that dispatched the intent. Unknown legacy ownership is
  // included only when the manager has exactly one credential group.
  private owns(record: { providerScope?: string }, includeUnscoped = false): boolean {
    return this.providerScope == null || record.providerScope === this.providerScope || (includeUnscoped && record.providerScope == null);
  }
  private observation(doc: AccountDoc): Limits | null {
    return this.providerScope == null ? doc.observation : doc.providerObservations?.[this.providerScope] ?? null;
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.accountId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    locks.set(this.accountId, tail);
    try { return await next; }
    finally { if (locks.get(this.accountId) === tail) locks.delete(this.accountId); }
  }
  private async read(): Promise<AccountDoc> {
    const raw = await this.state.get(this.key);
    if (raw == null) return { version: 1, observation: null, intents: [], usage: [], countedResumeUntil: null };
    const doc = raw as AccountDoc;
    if (doc.version !== 1 || !Array.isArray(doc.intents) || !Array.isArray(doc.usage)) throw new Error("account journal unreadable");
    // State clients may return object references. Never mutate uncommitted state.
    return structuredClone(doc);
  }
  private async write(doc: AccountDoc): Promise<void> {
    await this.state.set(this.key, doc);
    this.rows = structuredClone(doc.usage);
  }
  async load(): Promise<void> {
    await this.locked(async () => { this.rows = structuredClone((await this.read()).usage); });
  }
  usage(poolId: string): AccountUsageRow[] { return structuredClone(this.rows.filter((r) => r.poolId === poolId)); }

  /** Durable retention gate, independent of the pool's VM flags or cached rows. */
  async poolAccountingSettled(poolId: string): Promise<boolean> {
    return this.locked(async () => {
      const doc = await this.read();
      return doc.intents.filter((intent) => intent.poolId === poolId && this.owns(intent))
        .every((intent) => !intent.active && (intent.status === "stopped" || intent.status === "rejected"))
        && doc.usage.filter((row) => row.poolId === poolId && this.owns(row)).every((row) => row.tailSince === null);
    });
  }

  /**
   * Tracked VM seconds in the UTC calendar month containing nowMs, for one
   * company. Sums paid intervals clamped to the month plus the elapsed part
   * of still-open tails. Throws when the journal is unreadable: callers fail
   * closed (stay local) rather than dispatching unbounded on telemetry loss.
   */
  async monthVmSeconds(companyId: string, nowMs: number): Promise<number> {
    return this.locked(async () => {
      const doc = await this.read();
      return monthUsageSeconds(doc, companyId, nowMs);
    });
  }

  private async observe(api: BoatApiLike, doc: AccountDoc, allowCached = false, request?: AdmissionRequest): Promise<Limits> {
    const prior = this.observation(doc);
    const age = prior ? this.now() - prior.at : Infinity;
    if (allowCached && age >= 0 && age <= 5000 && prior!.periodEndMs > this.now()
      && Number.isFinite(prior!.includedHours) && prior!.nextStartDollars === 0) return prior!;
    let current: Limits;
    try {
      const raw = await bounded(() => api.limits({}));
      // Preserve an actionable refusal even for a partial exhausted response.
      // This projection can only REFUSE; every admission still requires the
      // complete, finite strict snapshot below.
      if (request && request.operation !== "warm") {
        const refusal = checkBudget(readBudget(raw), request, request.size, this.now());
        if (refusal) throw new BoatBudgetError(refusal);
      }
      current = parseLimits(raw, this.now());
    } catch (error) {
      if (error instanceof BoatBudgetError) throw error;
      throw new BoatProviderError("BOAT_LIMITS_UNAVAILABLE", "could not read fresh, complete boat limits; no new operation dispatched");
    }
    // Two credential groups may alias one provider account. Never refund the
    // same cumulative counter delta through multiple credential snapshots.
    // Pin one owner durably; other groups retain conservative unreflected holds.
    const scope = this.providerScope ?? "unscoped";
    doc.observationOwner ??= doc.observation ? "unscoped" : scope;
    if (prior && doc.observationOwner === scope) {
      let activeDelta = Math.max(0, current.active - prior.active);
      // Rollover, plan changes and legacy observations cannot attribute a
      // balance change to these holds. Retain their unreflected reservations.
      const samePeriod = current.periodEndMs === prior.periodEndMs && current.includedHours === prior.includedHours;
      let computeDelta = samePeriod ? Math.max(0, current.used - prior.used, prior.available - current.available) : 0;
      for (const intent of doc.intents) {
        if (intent.providerScope !== this.providerScope || intent.status === "rejected" || intent.settledAt == null) continue;
        if (activeDelta > 0 && intent.active && !intent.activeReflected) { intent.activeReflected = true; activeDelta--; }
        const consumed = Math.min(intent.compute, Math.max(0, ((intent.endedAt ?? this.now()) - intent.at) / 1000) * WEIGHT[intent.size]);
        const credit = Math.min(computeDelta, Math.max(0, consumed - intent.computeReflected));
        intent.computeReflected += credit; computeDelta -= credit;
      }
      for (const name of Object.keys(WINDOWS) as Window[]) {
        let delta = Math.max(0, (current.windows[name]?.used ?? 0) - (prior.windows[name]?.used ?? 0));
        for (const intent of doc.intents) {
          if (intent.providerScope !== this.providerScope || intent.status === "rejected" || intent.operation === "warm" || intent.settledAt == null) continue;
          const start = intent.starts[name];
          if (delta > 0 && !start.reflected && start.expiresAt > current.at) { start.reflected = true; delta--; }
        }
      }
    }
    if (this.providerScope == null) doc.observation = current;
    else (doc.providerObservations ??= {})[this.providerScope] = current;
    return current;
  }
  private tail(doc: AccountDoc, limits: Limits, req: AdmissionRequest): number {
    if (!req.poolId) return req.tailSeconds;
    const cap = Math.min(req.maxStartsPerDay, limits.windows.day?.limit ?? Infinity);
    const outstanding = doc.intents.filter((i) => this.pendingStart(i, "day", limits.at)).length;
    return ((limits.windows.day?.used ?? 0) + outstanding >= cap * 0.8 || (doc.countedResumeUntil ?? 0) > limits.at)
      ? Math.max(300, req.tailSeconds) : req.tailSeconds;
  }
  private pendingStart(intent: Intent, window: Window, at: number): boolean {
    // An unsettled (ambiguous or in-flight) start holds its window only until
    // the window resets: provider counters roll, so holding past expiresAt is
    // a permanent leak, not conservatism. Active/compute holds stay retained.
    return intent.operation !== "warm" && intent.status !== "rejected" && !intent.starts[window].reflected &&
      intent.starts[window].expiresAt > at;
  }
  private check(doc: AccountDoc, limits: Limits, req: AdmissionRequest, tailSeconds: number, ignore?: string): void {
    for (const value of [req.jobSeconds, tailSeconds, req.maxActive, req.maxStartsPerDay, req.minComputeHoursLeft]) number(value);
    const refuse = (limit: BudgetLimitName, message: string): never => { throw new BoatBudgetError({ limit, message, details: {} }); };
    const intents = doc.intents.filter((i) => i.id !== ignore && i.status !== "rejected");
    if (req.operation !== "warm") {
      if (!limits.canStart || limits.nextStartDollars !== 0) refuse("boat_cannot_start", "provider did not verify a zero-cost start");
      const active = limits.active + intents.filter((i) => i.active && !i.activeReflected).length;
      if (active + 1 > Math.min(req.maxActive, limits.activeCap)) refuse("maxActive", "account active capacity exhausted");
      for (const name of Object.keys(WINDOWS) as Window[]) {
        const window = limits.windows[name];
        const pending = intents.filter((i) => this.pendingStart(i, name, limits.at)).length;
        const configured = name === "day" ? req.maxStartsPerDay : Infinity;
        if ((window?.used ?? 0) + pending + 1 > Math.min(configured, window?.limit ?? Infinity) || (window && pending + 1 > window.remaining)) {
          refuse(name === "day" ? "maxStartsPerDay" : name === "hour" ? "boatStartsPerHour" : "boatStartsPerMinute", `account ${name} start capacity exhausted`);
        }
      }
    }
    // No allowance beyond this billing boundary is known. Fund the complete
    // preparation/command/idle envelope without assuming next period's plan.
    if (!Number.isFinite(limits.periodEndMs) || this.now() + Math.max(60, Math.ceil(req.jobSeconds + tailSeconds)) * 1000 > limits.periodEndMs) {
      refuse("minComputeHoursLeft", "included billing period does not fund the complete lifetime");
    }
    const machine = limits.sizes.find((s) => s.type === req.size);
    if (!machine?.available) refuse("machineType", "unavailable size");
    const committed = intents.reduce((sum, i) => sum + Math.max(0, i.compute - i.computeReflected), 0);
    if (limits.available - committed < (req.jobSeconds + tailSeconds) * WEIGHT[req.size] + req.minComputeHoursLeft * 3600) {
      refuse("minComputeHoursLeft", "insufficient job plus tail compute and reserve");
    }
  }
  /**
   * Latest billable instant for an open tail: terminal evidence observed at
   * `at`, but never later than the requested stop deadline plus grace, nor
   * later than the funded tail plus grace when the stop receipt itself lagged.
   * The grace bills a retried stop's actual minutes while still bounding a
   * receipt that arrives days late.
   */
  private tailEnd(doc: AccountDoc, row: AccountUsageRow, at: number): number {
    if (row.tailSince == null) return at;
    const intent = doc.intents.find((i) => i.usageId != null && i.usageId === row.usageRecordId);
    const tailBudget = intent != null && Number.isFinite(intent.tailSeconds)
      ? row.tailSince + (intent.tailSeconds + STOP_OBSERVE_GRACE_S) * 1000 : null;
    const requestedCap = row.stopDueAt != null ? row.stopDueAt + STOP_OBSERVE_GRACE_S * 1000 : Infinity;
    return Math.min(at, requestedCap, tailBudget ?? Infinity);
  }
  private closeTail(doc: AccountDoc, sandboxId: string, at: number, includeUnscoped = false): void {
    for (const row of doc.usage) {
      if (!this.owns(row, includeUnscoped) || row.sandboxId !== sandboxId || row.tailSince == null) continue;
      const end = this.tailEnd(doc, row, at);
      if (end > row.tailSince) row.intervals.push({ since: new Date(row.tailSince).toISOString(), until: new Date(end).toISOString(), phase: "idle_tail" });
      row.tailSince = null;
      const intent = doc.intents.find((i) => i.usageId === row.usageRecordId);
      if (intent) { intent.endedAt = end; intent.compute = Math.min(intent.compute, Math.max(0, (end - intent.at) / 1000) * WEIGHT[intent.size]); }
    }
  }
  /**
   * Retire starts whose provider TTL plus margin has passed while their
   * effect stayed ambiguous (or was never reported, e.g. a crash between
   * reserve and started/failed). Boat auto-stops such VMs, so the hold is
   * dead capacity: release it, cap its compute at the TTL envelope, and leave
   * an aborted_start interval that ends no later than at + ttl. Only intents
   * this ledger owns are touched; settled and running intents never are.
   */
  private expireStaleHolds(doc: AccountDoc, now: number, includeUnscoped = false): void {
    for (const intent of doc.intents) {
      if (!this.owns(intent, includeUnscoped) || (intent.status !== "intent" && intent.status !== "ambiguous")) continue;
      if (intent.settledAt != null && intent.sandboxId != null) continue;
      const ttlSeconds = Number.isFinite(intent.ttlSeconds) && intent.ttlSeconds > 0
        ? intent.ttlSeconds : intent.jobSeconds + intent.tailSeconds;
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) continue;
      if (now <= intent.at + ttlSeconds * 1000 + STALE_HOLD_MARGIN_MS) continue;
      intent.active = false;
      intent.settledAt = now;
      intent.endedAt ??= Math.min(now, intent.at + ttlSeconds * 1000);
      // Release the unconsumed compute reservation: no live VM can consume it
      // (boat auto-stopped it at the TTL) and the provider counter never will,
      // so holding it would exhaust compute after repeated ambiguous starts.
      // Already-reflected provider usage is kept so a later observation cannot
      // double-refund it. The bounded bill lives on the row interval below.
      intent.compute = Math.min(intent.compute, intent.computeReflected);
      // Mark the hold terminal so a later archived listing cannot rewrite the
      // TTL-clamped interval below into [at, now] via terminal().
      intent.status = "stopped";
      const row = intent.usageId != null ? doc.usage.find((r) => r.usageRecordId === intent.usageId) : undefined;
      if (row != null && now > intent.at) {
        row.kind = "aborted_start";
        const end = Math.min(now, intent.at + ttlSeconds * 1000);
        row.intervals = [{ since: new Date(intent.at).toISOString(), until: new Date(end).toISOString(), phase: "command" }];
      }
    }
  }

  async reserve(api: BoatApiLike, req: AdmissionRequest): Promise<AccountReservation> {
    return await this.locked(async () => {
      const doc = await this.read();
      // A restart may have left ambiguous or never-reported starts behind;
      // retire them before they refuse this admission as phantom capacity.
      this.expireStaleHolds(doc, this.now());
      // Strict: the new request's own envelope counts too. The old
      // used-only check admitted one full extra envelope past the cap.
      const monthly = req.monthlyCap && req.monthlyCap.capHours > 0 && req.monthlyCap.companyId
        ? { ...req.monthlyCap,
            used: monthUsageSeconds(doc, req.monthlyCap.companyId, req.monthlyCap.nowMs)
              + pendingCapSeconds(doc, req.monthlyCap.companyId) }
        : null;
      const refuseOverCap = (envelopeSeconds: number): void => {
        if (monthly && (monthly.used + envelopeSeconds) / 3600 > monthly.capHours) {
          throw new BoatBudgetError({ limit: "minComputeHoursLeft",
            message: `monthly offload VM-hour cap reached (${monthly.capHours}h); new commands run local until next month`,
            details: {} });
        }
      };
      refuseOverCap(req.jobSeconds + req.tailSeconds);
      let limits = await this.observe(api, doc, req.allowCachedLimits, req);
      const tailSeconds = this.tail(doc, limits, req);
      // tail() can raise a short tail to 300 s under start pressure after the
      // early check above: recheck the committed (larger) envelope, otherwise
      // the strict comparison would not cover the admitted VM time.
      if (tailSeconds > req.tailSeconds) refuseOverCap(req.jobSeconds + tailSeconds);
      // A warm handoff or a new resume reservation truncates the previous tail,
      // but only on a committed new reservation. A refusal must leave the
      // original tail and timer intact. A resume starts a new command on the
      // same VM: without this the predecessor's tail would run until the later
      // terminal receipt and the overlapping seconds would be billed twice.
      const candidate = structuredClone(doc);
      if (req.sandboxId && (req.operation === "warm" || req.operation === "resume")) {
        this.closeTail(candidate, req.sandboxId, this.now());
        if (!req.poolId) {
          // Concurrent leases share one machine, not N overlapping TTL bills.
          // Preserve any longer funded deadline while closing prior envelopes.
          let remaining = req.jobSeconds;
          for (const prior of candidate.intents) {
            if (!this.owns(prior) || prior.sandboxId !== req.sandboxId || prior.endedAt != null || prior.status === "rejected") continue;
            remaining = Math.max(remaining, (prior.at + prior.jobSeconds * 1000 - this.now()) / 1000);
            prior.endedAt = this.now();
            prior.compute = Math.min(prior.compute, Math.max(0, (prior.endedAt - prior.at) / 1000) * WEIGHT[prior.size]);
          }
          req = { ...req, jobSeconds: remaining };
        }
      }
      this.check(candidate, limits, req, tailSeconds);
      const at = this.now(), id = randomUUID();
      const starts = {} as Intent["starts"];
      for (const name of Object.keys(WINDOWS) as Window[]) starts[name] = { reflected: false, expiresAt: limits.windows[name]?.resetAt ?? at + WINDOWS[name] };
      const intent: Intent = { id, providerScope: this.providerScope, poolId: req.poolId ?? null, sandboxId: req.sandboxId ?? null, operation: req.operation, at,
        settledAt: null, status: "intent", active: req.operation !== "warm", activeReflected: false, starts,
        compute: (req.jobSeconds + tailSeconds) * WEIGHT[req.size], computeReflected: 0, size: req.size, jobSeconds: req.jobSeconds,
        tailSeconds, ttlSeconds: Math.max(60, Math.ceil(req.jobSeconds + tailSeconds)),
        reserveSeconds: req.minComputeHoursLeft * 3600, endedAt: null, usageId: req.command ? id : null };
      candidate.intents.push(intent);
      if (req.command && req.poolId) candidate.usage.push({ usageRecordId: id, providerScope: this.providerScope, poolId: req.poolId, kind: "command",
        commandId: req.command.commandId, runId: req.command.runId, cardId: req.command.cardId, repoId: req.command.repoId,
        companyId: req.command.companyId, profileId: req.command.profileId, payloadDigest: req.command.payloadDigest,
        sandboxId: req.sandboxId ?? null, seconds: 0, dollars: 0, meterProvenance: "pending", observedStartsDelta: null, intervals: [], tailSince: null,
        stopRequestedAt: null, stoppedAt: null, stopLagMs: null, stopDueAt: null });
      await this.write(candidate);
      // Persistence may itself have waited for the store. Revalidate the exact
      // intent before any external effect if its observation aged out.
      try {
        this.assertDispatchable({ id, tailSeconds, at, periodEndMs: limits.periodEndMs }, intent.ttlSeconds);
      } catch (error) {
        await this.write(doc);
        throw error;
      }
      if (this.now() - limits.at > 5000) {
        try {
          limits = await this.observe(api, candidate);
          this.check(candidate, limits, req, tailSeconds, id);
          await this.write(candidate);
          this.assertDispatchable({ id, tailSeconds, at, periodEndMs: limits.periodEndMs }, intent.ttlSeconds);
          if (this.now() - limits.at > 5000) throw new Error("limits expired while persisting admission");
        } catch (error) {
          // No external effect occurred. Restore the predecessor's open tail;
          // the rejected handoff must not erase time that the old timer owns.
          await this.write(doc);
          throw error;
        }
      }
      return { id, tailSeconds, at, periodEndMs: limits.periodEndMs };
    });
  }

  /** Synchronous final check: caller persistence must not outlive the funded period. */
  assertDispatchable(reservation: AccountReservation, ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || !Number.isFinite(reservation.periodEndMs)
      || this.now() + ttlSeconds * 1000 > reservation.periodEndMs!) {
      throw new BoatBudgetError({ limit: "minComputeHoursLeft", message: "included billing period no longer funds dispatch", details: {} });
    }
  }

  async revalidate(api: BoatApiLike, reservation: AccountReservation, req: AdmissionRequest): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      const limits = await this.observe(api, doc);
      this.check(doc, limits, req, reservation.tailSeconds, reservation.id);
      await this.write(doc);
      reservation.periodEndMs = limits.periodEndMs;
      this.assertDispatchable(reservation, Math.max(60, Math.ceil(req.jobSeconds + reservation.tailSeconds)));
      if (this.now() - limits.at > 5000) throw new Error("limits expired before retry");
    });
  }

  /** A same-key replay may be the first effective create. Fund it before POST,
   * retaining the old elapsed exposure and renewing all unreflected holds. */
  async revalidateReplay(api: BoatApiLike, reservation: AccountReservation, req: AdmissionRequest, ttlSeconds: number): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      const intent = doc.intents.find((i) => i.id === reservation.id && this.owns(i));
      if (!intent || intent.operation !== "create" || intent.size !== req.size
        || !["intent", "ambiguous"].includes(intent.status) || !Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
        throw new Error("no retained create intent can fund replay");
      }
      const limits = await this.observe(api, doc, false, req);
      const ttlBound = Math.max(intent.ttlSeconds, Math.ceil(Math.max(0, this.now() - intent.at) / 1000) + ttlSeconds);
      const jobSeconds = ttlBound - intent.tailSeconds;
      this.check(doc, limits, { ...req, jobSeconds }, intent.tailSeconds, intent.id);
      if (req.monthlyCap && req.monthlyCap.capHours > 0
        && (monthUsageSeconds(doc, req.monthlyCap.companyId, this.now()) + pendingCapSeconds(doc, req.monthlyCap.companyId)
          + Math.max(0, jobSeconds - intent.jobSeconds)) / 3600 > req.monthlyCap.capHours) {
        throw new Error("monthly offload VM-hour cap reached during replay");
      }
      intent.jobSeconds = jobSeconds;
      intent.ttlSeconds = ttlBound;
      intent.compute = Math.max(intent.compute, ttlBound * WEIGHT[intent.size]);
      intent.active = true;
      intent.activeReflected = false;
      for (const name of Object.keys(WINDOWS) as Window[]) {
        intent.starts[name] = { reflected: false, expiresAt: limits.windows[name]?.resetAt ?? this.now() + WINDOWS[name] };
      }
      await this.write(doc);
      reservation.periodEndMs = limits.periodEndMs;
      this.assertDispatchable(reservation, ttlSeconds);
      if (this.now() - limits.at > 5000) throw new Error("limits expired before create replay");
    });
  }

  /** Undo an optional extension only before its provider update was attempted. */
  async restoreTail(reservation: AccountReservation): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      const released = Math.max(0, intent.tailSeconds - reservation.tailSeconds) * WEIGHT[intent.size];
      intent.compute = Math.max(intent.computeReflected, intent.compute - released);
      intent.tailSeconds = reservation.tailSeconds;
      await this.write(doc);
    });
  }

  async started(api: BoatApiLike, reservation: AccountReservation, sandboxId: string): Promise<number> {
    return await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      intent.sandboxId = sandboxId; intent.status = "running"; intent.settledAt = this.now();
      const row = doc.usage.find((r) => r.usageRecordId === intent.usageId);
      if (row) row.sandboxId = sandboxId;
      // Record, never assume, whether this particular resume spent a start.
      if (intent.operation === "resume" && intent.poolId) {
        const before = this.observation(doc)?.windows.day?.used;
        try {
          const limits = await this.observe(api, doc), after = limits.windows.day?.used;
          const delta = before != null && after != null ? Math.max(0, after - before) : null;
          if (row) row.observedStartsDelta = delta;
          if (delta != null && delta > 0) {
            doc.countedResumeUntil = limits.windows.day?.resetAt ?? this.now() + WINDOWS.day;
            if (intent.poolId && intent.tailSeconds < 300) {
              this.assertDispatchable({ ...reservation, periodEndMs: limits.periodEndMs }, Math.max(60, Math.ceil(intent.jobSeconds + 300)));
              const extra = (300 - intent.tailSeconds) * WEIGHT[intent.size];
              const outstanding = doc.intents.reduce((n, i) => n + Math.max(0, i.compute - i.computeReflected), 0);
              if (limits.available - outstanding < extra + intent.reserveSeconds) throw new Error("insufficient compute for metered-resume tail");
              intent.compute += extra; intent.tailSeconds = 300;
            }
          }
        } catch {
          // The resume has already taken effect: the VM is running and the
          // command must proceed. Keep the shorter funded tail (already
          // persisted above) rather than failing a live start after the fact.
          await this.write(doc);
          return intent.tailSeconds;
        }
      }
      await this.write(doc);
      return intent.tailSeconds;
    });
  }

  /** Renew an unsettled intent's provider-deadline bound after a confirmed
   * TTL extension, so the hold survives through the real auto-stop instead of
   * the original TTL. Only ever raises the bound. */
  async extendTtl(reservation: AccountReservation, ttlSeconds: number): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      if (Number.isFinite(ttlSeconds) && ttlSeconds > intent.ttlSeconds) intent.ttlSeconds = Math.ceil(ttlSeconds);
      await this.write(doc);
    });
  }

  async failed(reservation: AccountReservation, definitive: boolean): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      intent.status = definitive ? "rejected" : "ambiguous";
      if (definitive) { intent.active = false; intent.compute = 0; intent.settledAt = this.now(); }
      const row = doc.usage.find((r) => r.usageRecordId === intent.usageId);
      if (row) {
        row.kind = definitive ? "failed_start" : "aborted_start";
        row.meterProvenance = definitive ? "estimate" : "pending";
        if (!definitive && this.now() > intent.at) row.intervals = [{ since: new Date(intent.at).toISOString(), until: new Date(this.now()).toISOString(), phase: "command" }];
      }
      await this.write(doc);
    });
  }

  async finished(reservation: AccountReservation, unknown: boolean,
    metadata: Pick<AccountUsageRow, "warm" | "queueWaitMs" | "exitCode" | "outcome" | "expectedSeconds" | "expectedDollars"> = {},
    finishedAt = this.now()): Promise<void> {
    // Defense in depth: copy only typed scalar fields, never a guest-shaped
    // object wholesale, so a compromised upstream cannot plant unbounded
    // bytes or unexpected keys in the shared account document.
    const safe: typeof metadata = {
      warm: metadata.warm === "warm" ? "warm" : "cold",
      queueWaitMs: Number.isFinite(metadata.queueWaitMs) && (metadata.queueWaitMs as number) >= 0
        ? Math.floor(metadata.queueWaitMs as number) : 0,
      exitCode: Number.isInteger(metadata.exitCode) ? metadata.exitCode as number : 75,
      outcome: metadata.outcome === "completed" ? "completed" : "unknown",
      expectedSeconds: Number.isFinite(metadata.expectedSeconds) && (metadata.expectedSeconds as number) >= 0
        ? metadata.expectedSeconds as number : 0,
      expectedDollars: Number.isFinite(metadata.expectedDollars) ? metadata.expectedDollars as number : 0,
    };
    await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      // A lost journal finish may complete accounting on a later sweep. Keep
      // the original host-measured boundary, and never reopen an observed stop.
      // An unknown transport result is not a verified end. Once stopped, its
      // terminal boundary remains billable even if finish recovery runs later.
      const boundary = unknown && intent.status === "stopped" ? intent.endedAt ?? finishedAt : finishedAt;
      const at = Math.max(intent.at, Math.min(boundary, this.now(), intent.endedAt ?? Infinity));
      const row = doc.usage.find((r) => r.usageRecordId === intent.usageId);
      if (row) {
        Object.assign(row, safe);
        row.intervals = at > intent.at
          ? [{ since: new Date(intent.at).toISOString(), until: new Date(at).toISOString(), phase: "command" }] : [];
        row.tailSince = unknown ? null : at;
        if (intent.status === "stopped" && row.tailSince !== null) {
          // Terminal reconciliation can precede a recovered finish write.
          // Rebuild its bounded billed tail without reopening a stopped VM.
          const end = this.tailEnd(doc, row, intent.endedAt ?? at);
          if (end > at) row.intervals.push({ since: new Date(at).toISOString(), until: new Date(end).toISOString(), phase: "idle_tail" });
          row.tailSince = null;
        }
        row.seconds = Math.max(0, (at - intent.at) / 1000) * WEIGHT[intent.size];
        row.meterProvenance = "pending";
      }
      if (intent.status !== "stopped") {
        if (unknown) intent.status = "ambiguous";
        else intent.compute = Math.max(0, (at - intent.at) / 1000 + intent.tailSeconds) * WEIGHT[intent.size];
      }
      await this.write(doc);
    });
  }

  async stopRequested(sandboxId: string, dueAt: number, requestedAt: number, reservationId?: string): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      for (const row of doc.usage) {
        // Exact reservation binding also repairs a missed intent write after
        // terminal reconciliation closed its tail, without stamping old callers.
        if (!this.owns(row) || row.sandboxId !== sandboxId || row.stopRequestedAt != null
          || (reservationId ? row.usageRecordId !== reservationId : row.tailSince === null)) continue;
        row.stopDueAt = dueAt;
        row.stopRequestedAt = requestedAt;
        row.stoppedAt = row.stopLagMs = null;
      }
      await this.write(doc);
    });
  }

  async stopped(sandboxId: string, at = this.now(), reservationId?: string): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      this.terminal(doc, sandboxId, at, false, reservationId);
      await this.write(doc);
    });
  }
  private terminal(doc: AccountDoc, sandboxId: string, at: number, includeUnscoped = false, reservationId?: string): void {
    for (const row of doc.usage) {
      // A warm handoff cancels the predecessor's stop obligation. An exact
      // reservation can repair its closed tail with earlier durable evidence,
      // but must never stamp an older caller's cancelled tail.
      if (this.owns(row, includeUnscoped) && row.sandboxId === sandboxId
        && (row.tailSince != null || row.usageRecordId === reservationId)
        && row.stopDueAt != null
        && (row.stoppedAt == null || row.usageRecordId === reservationId && at < row.stoppedAt)) {
        row.stoppedAt = at;
        row.stopLagMs = Math.max(0, at - row.stopDueAt);
      }
    }
    this.closeTail(doc, sandboxId, at, includeUnscoped);
    for (const intent of doc.intents) {
      if (!this.owns(intent, includeUnscoped) || intent.sandboxId !== sandboxId || intent.status === "stopped" || intent.status === "rejected") continue;
      // An intent whose external effect has not settled (no started/failed yet)
      // is owned by its in-flight transition, not by inventory evidence: a
      // stale archived listing must never retire a pending resume's capacity.
      // Only started() / failed() settle such intents.
      if (intent.status === "intent" && intent.settledAt == null) continue;
      if (intent.status === "ambiguous" || intent.status === "intent") {
        const row = doc.usage.find((r) => r.usageRecordId === intent.usageId);
        if (row && at > intent.at) row.intervals = [{ since: new Date(intent.at).toISOString(), until: new Date(at).toISOString(), phase: "command" }];
      }
      intent.active = false; intent.status = "stopped"; intent.settledAt ??= at;
      intent.endedAt ??= at;
      intent.compute = Math.min(intent.compute, Math.max(0, (intent.endedAt - intent.at) / 1000) * WEIGHT[intent.size]);
    }
  }

  async reconcile(api: BoatApiLike, inventory?: ReadonlyArray<{ id: string; state: string }>, allowCachedLimits = false, includeUnscoped = false,
    poolId?: string): Promise<void> {
    const ids = await this.locked(async () => {
      const doc = await this.read();
      // Retire ambiguous or never-reported starts whose provider TTL plus
      // margin has passed, including intents with no sandboxId that terminal
      // receipts can never settle (e.g. a crash between reserve and create).
      this.expireStaleHolds(doc, this.now(), includeUnscoped);
      try { await this.observe(api, doc, allowCachedLimits); } catch { /* Never free a reservation on unreadable limits. */ }
      // A pool client has no credential-group inventory for the rest of the
      // shared journal. Limit both receipt checks and subsequent metering to
      // its durably known VM identities, including after pool reconstruction.
      const owned = doc.intents.filter((i) => this.owns(i, includeUnscoped) && (poolId == null || i.poolId === poolId));
      const all = [...new Set(owned.map((i) => i.sandboxId).filter((id): id is string => id != null))];
      const active = new Set(owned.filter((i) => i.active && i.sandboxId != null).map((i) => i.sandboxId!));
      const history = all.filter((id) => !active.has(id));
      const savedCursor = this.providerScope == null ? doc.reconcileCursor : doc.providerCursors?.[this.providerScope];
      const cursor = Number.isSafeInteger(savedCursor) && savedCursor! >= 0 ? savedCursor! % Math.max(1, history.length) : 0;
      // Live holds always get a terminal-receipt check. Rotate historical bills
      // so an old hundred-VM prefix cannot starve new holds or late corrections.
      const ids = [...active, ...history.slice(cursor), ...history.slice(0, cursor)].slice(0, 100);
      const nextCursor = (cursor + Math.max(0, ids.length - active.size)) % Math.max(1, history.length);
      if (this.providerScope == null) doc.reconcileCursor = nextCursor;
      else (doc.providerCursors ??= {})[this.providerScope] = nextCursor;
      for (const id of ids) {
        // A listing is a point-in-time snapshot: when this ledger still holds
        // a live (non-terminal) reservation for the sandbox, a listed terminal
        // state may predate a concurrent resume. Re-check terminal evidence
        // with a fresh read before retiring a live hold. A listed non-terminal
        // state needs no re-check: it cannot retire anything.
        const liveHold = owned.some((i) => i.sandboxId === id && i.status !== "stopped" && i.status !== "rejected");
        try {
          const listed = inventory?.find((vm) => vm.id === id);
          const listedTerminal = listed && ["archived", "cancelled", "deleted"].includes(listed.state ?? "");
          const box = listed && (!liveHold || !listedTerminal)
            ? listed
            : (await bounded(() => api.get({ sandboxId: id }))).sandbox;
          if (box && ["archived", "cancelled", "deleted"].includes(box.state ?? "")) this.terminal(doc, id, this.now(), includeUnscoped);
        } catch (error) {
          // A 404 is terminal only for identities bound to this credential.
          // A legacy unbound hold may belong to an unavailable account even
          // when just one group is configured now. Require positive terminal
          // evidence for it, never infer ownership from a foreign 404.
          if ((await describeBoatError(error)).status === 404) this.terminal(doc, id, this.now());
        }
      }
      await this.write(doc);
      return ids;
    });
    // Interval IO grows with command history. It must never own admission's
    // mutex: calculate a detached projection, then merge only if its source
    // rows (including open tails and concurrent commands) are still current.
    for (const id of ids) await this.reconcileUsage(api, id, includeUnscoped);
  }
  private async reconcileUsage(api: BoatApiLike, sandboxId: string, includeUnscoped: boolean): Promise<void> {
    const snapshot = await this.locked(() => this.read());
    const rowsForVm = (doc: AccountDoc) => doc.usage.filter((r) => r.sandboxId === sandboxId);
    const before = JSON.stringify(rowsForVm(snapshot));
    if (!await this.meter(api, snapshot, sandboxId, includeUnscoped)) return;
    await this.locked(async () => {
      const current = await this.read();
      if (JSON.stringify(rowsForVm(current)) !== before) return; // Explicitly pending until a later pass.
      const projection = new Map(rowsForVm(snapshot).map((r) => [r.usageRecordId, r]));
      current.usage = current.usage.map((row) => {
        const replacement = projection.get(row.usageRecordId);
        projection.delete(row.usageRecordId);
        return replacement ?? row;
      });
      current.usage.push(...projection.values());
      await this.write(current);
    });
  }
  private async meter(api: BoatApiLike, doc: AccountDoc, sandboxId: string, includeUnscoped = false): Promise<boolean> {
    const rows = doc.usage.filter((r) => this.owns(r, includeUnscoped) && r.sandboxId === sandboxId && r.kind !== "overhead");
    if (!rows.length) return false;
    try {
      const full = await bounded(() => api.usage({ sandboxId }));
      if (!full.ok) throw new Error("usage unavailable");
      const since = date(full.since), until = date(full.until);
      if (since == null || until == null || until < since) throw new Error("usage interval unavailable");
      const covered: Array<[number, number]> = [];
      for (const row of rows) {
        let seconds = 0, dollars = 0;
        for (const interval of row.intervals) {
          const start = Date.parse(interval.since), end = Date.parse(interval.until);
          const reading = await bounded(() => api.usage({ sandboxId, since: interval.since, until: interval.until }));
          if (!reading.ok) throw new Error("usage unavailable");
          seconds += number(reading.seconds); dollars += number(reading.dollars);
          covered.push([start, end]);
        }
        row.seconds = seconds; row.dollars = dollars;
        row.meterProvenance = row.tailSince == null ? "provider" : "pending";
      }
      covered.sort((a, b) => a[0] - b[0]);
      const gaps: PaidInterval[] = [];
      let cursor = since;
      for (const [start, end] of covered) {
        if (start > cursor) gaps.push({ since: new Date(cursor).toISOString(), until: new Date(Math.min(start, until)).toISOString(), phase: "overhead" });
        cursor = Math.max(cursor, end);
      }
      if (cursor < until) gaps.push({ since: new Date(cursor).toISOString(), until: new Date(until).toISOString(), phase: "overhead" });
      let seconds = 0, dollars = 0;
      const intervals: PaidInterval[] = [];
      for (const gap of gaps) {
        if (Date.parse(gap.until) <= Date.parse(gap.since)) continue;
        const reading = await bounded(() => api.usage({ sandboxId, since: gap.since, until: gap.until }));
        if (!reading.ok) throw new Error("usage unavailable");
        if (number(reading.seconds) === 0 && number(reading.dollars) === 0) continue;
        seconds += number(reading.seconds); dollars += number(reading.dollars); intervals.push(gap);
      }
      const overheadId = `overhead:${sandboxId}`;
      const overhead = doc.usage.find((r) => r.usageRecordId === overheadId);
      if (seconds > 0 || overhead) {
        const row: AccountUsageRow = { usageRecordId: overheadId, providerScope: this.providerScope, poolId: rows[0].poolId, kind: "overhead", commandId: null, runId: null, cardId: null, repoId: null,
          sandboxId, seconds, dollars, intervals, tailSince: null, observedStartsDelta: null, meterProvenance: "provider" };
        if (overhead) Object.assign(overhead, row); else doc.usage.push(row);
      }
      const allocated = rows.reduce((n, r) => n + r.seconds, 0) + seconds;
      const tolerance = Math.max(0.001 * (covered.length + gaps.length + 1), number(full.seconds) * 0.000001);
      const allocatedDollars = rows.reduce((n, r) => n + r.dollars, 0) + dollars;
      // SDK dollars are rounded to six decimals; bounded interval rounding is
      // not a missing bill. Larger disagreements remain pending for a later read.
      if (Math.abs(allocated - number(full.seconds)) > tolerance ||
        Math.abs(allocatedDollars - number(full.dollars)) > (covered.length + gaps.length + 1) * 0.000001) throw new Error("provider usage has not converged");
      return true;
    } catch {
      // Interval reads are one detached accounting transaction. Never commit a
      // partial correction or erase a previously converged provider bill.
      return false;
    }
  }
}
