// Capacity telemetry: parse Boat's flat limits payload and keep a bounded,
// durable, sampled history per account so the 5-minute sweep and GET usage can
// report an included-VM-hours forecast and start-rate pressure. Report only:
// nothing here spends money, changes a plan, or stops a VM. Legacy credit
// fields are never read; the included balance is planIncluded.vmHoursRemaining.
// Anything unparseable is "unavailable", never healthy.
import { createHash } from "node:crypto";
import type { StateClientLike } from "./state.js";

const NAMESPACE = "capacity";
const STATE_KEY = "samples";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const MAX_ACCOUNTS = 8;
export const MAX_SAMPLES = 2560; // 8d at the 4.5 minute minimum spacing
export const RETENTION_MS = 8 * DAY_MS;
export const BASELINE_TOLERANCE_MS = 15 * 60_000;
export const MIN_SAMPLE_SPACING_MS = 270_000;
export const STALE_AFTER_MS = 15 * 60_000;
export const NOTIFY_REPEAT_MS = DAY_MS;
export const FORECAST_MARGIN = 1.25;
export const RESERVE_HOURS = 5;
const PRESSURE_NUM = 4; // pressure at used/limit >= 4/5, compared in integers
const PRESSURE_DEN = 5;
const MAX_HOURS = 1e7;
const MAX_COUNT = 1e9;
const EPS = 1e-6;

export interface StartWindow { used: number; limit: number; remaining: number }
export interface ParsedLimits {
  periodEndMs: number;
  vmHours: number;
  vmHoursRemaining: number;
  /** null when the plan reports unlimited starts. */
  starts: { minute: StartWindow; hour: StartWindow; day: StartWindow } | null;
  activeSandboxes: number;
  maxActiveSandboxes: number;
  canStart: boolean | null;
}

export type ParseResult = { ok: true; limits: ParsedLimits } | { ok: false; reason: string };

function num(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseWindow(v: unknown): StartWindow | null {
  const o = obj(v);
  if (!o) return null;
  const used = num(o.used, MAX_COUNT), limit = num(o.limit, MAX_COUNT), remaining = num(o.remaining, MAX_COUNT);
  return used === null || limit === null || remaining === null ? null : { used, limit, remaining };
}

/** Parse a limits payload (flat, or legacy `_package` / `upgradeEffects` nesting). */
export function parseLimits(raw: unknown): ParseResult {
  const root = obj(raw);
  if (!root) return { ok: false, reason: "malformed_payload" };
  if (root.ok === false) return { ok: false, reason: "payload_not_ok" };
  const body = [root, obj(root._package), obj(root.upgradeEffects)].find((c) => c && obj(c.planIncluded));
  if (!body) return { ok: false, reason: "missing_plan_included" };
  const plan = obj(body.planIncluded)!;
  const vmHours = num(plan.vmHours, MAX_HOURS), remaining = num(plan.vmHoursRemaining, MAX_HOURS);
  if (vmHours === null || remaining === null || remaining > vmHours + EPS) return { ok: false, reason: "invalid_vm_hours" };
  // The pinned SDK decodes periodEnd to a Date; a raw JSON payload has a string.
  const periodEndMs = plan.periodEnd instanceof Date ? plan.periodEnd.getTime()
    : typeof plan.periodEnd === "string" ? Date.parse(plan.periodEnd) : NaN;
  if (!Number.isFinite(periodEndMs)) return { ok: false, reason: "invalid_period_end" };
  const startsRaw = obj(body.starts);
  if (!startsRaw || typeof startsRaw.unlimited !== "boolean") return { ok: false, reason: "invalid_starts" };
  let starts: ParsedLimits["starts"] = null;
  if (!startsRaw.unlimited) {
    const minute = parseWindow(startsRaw.minute), hour = parseWindow(startsRaw.hour), day = parseWindow(startsRaw.day);
    if (!minute || !hour || !day) return { ok: false, reason: "invalid_starts" };
    starts = { minute, hour, day };
  }
  const active = num(body.activeSandboxes, MAX_COUNT), maxActive = num(body.maxActiveSandboxes, MAX_COUNT);
  if (active === null || maxActive === null) return { ok: false, reason: "invalid_active_sandboxes" };
  if (body.canStart !== undefined && typeof body.canStart !== "boolean") return { ok: false, reason: "invalid_can_start" };
  return {
    ok: true,
    limits: {
      periodEndMs, vmHours, vmHoursRemaining: remaining, starts,
      activeSandboxes: active, maxActiveSandboxes: maxActive,
      canStart: typeof body.canStart === "boolean" ? body.canStart : null,
    },
  };
}

/** used/limit >= 80% on an actual cap; a zero cap never divides. */
function atPressure(used: number, limit: number): boolean {
  return limit > 0 && used * PRESSURE_DEN >= limit * PRESSURE_NUM;
}

export function startPressureReasons(l: ParsedLimits): string[] {
  const reasons: string[] = [];
  if (l.starts) {
    for (const name of ["minute", "hour", "day"] as const) {
      if (atPressure(l.starts[name].used, l.starts[name].limit)) reasons.push(`start_${name}_pressure`);
    }
  }
  if (atPressure(l.activeSandboxes, l.maxActiveSandboxes)) reasons.push("active_sandboxes_pressure");
  if (l.canStart === false) reasons.push("cannot_start");
  return reasons;
}

/** [t, periodEndMs, vmHours total, vmHoursRemaining] */
type Sample = [number, number, number, number];

export interface ForecastReport {
  status: "ok" | "insufficient_history";
  /** Hours consumed over the trailing 24h, or null without a baseline in tolerance. */
  burn24hHours: number | null;
  /** Hours per day averaged over the trailing 7d, or null without a baseline. */
  avg7dDailyHours: number | null;
  daysRemaining: number;
  remainingHours: number;
  /** remainingHours - 5: the projection must not exceed this. */
  thresholdHours: number;
  /** 1.25 * max(available burn rates) * daysRemaining, or null with no burn data. */
  projectedHours: number | null;
  /** null when there is nothing to compare (no 24h window). */
  exceeds: boolean | null;
}

export interface CapacityReport {
  accountId: string; // digest of the caller's opaque key, never the key
  status: "fresh" | "insufficient" | "unavailable";
  observedAt: string | null;
  observedAtMs: number | null;
  /** Span from the oldest same-plan sample to this observation. */
  coverageMs: number;
  /** Warning plus informational reasons (e.g. insufficient_history, or the unavailable cause). */
  reasons: string[];
  warning: boolean;
  warningReasons: string[];
  /** Log hint: warning reasons changed, or the same warning has run >= 24h since the last hint. */
  shouldNotify: boolean;
  plan: { periodEnd: string; vmHours: number; vmHoursRemaining: number } | null;
  forecast: ForecastReport | null;
  startPressure: {
    pressure: boolean;
    reasons: string[];
    starts: ParsedLimits["starts"];
    activeSandboxes: number;
    maxActiveSandboxes: number;
    canStart: boolean | null;
  } | null;
}

interface Marker { reasons: string[]; lastNotifiedMs: number }
interface AccountDoc { seenAt: number; samples: Sample[]; marker: Marker | null; report: CapacityReport | null }
interface CapacityDoc { version: 1; accounts: Record<string, AccountDoc> }

function digest(accountKey: string): string {
  return createHash("sha256").update(accountKey).digest("hex").slice(0, 16);
}

function baseline(samples: Sample[], target: number): Sample | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const t = samples[i][0];
    if (t <= target) return t >= target - BASELINE_TOLERANCE_MS ? samples[i] : null;
  }
  return null;
}

export function buildForecast(history: Sample[], cur: Sample, nowMs: number): ForecastReport {
  const [, end, , remaining] = cur;
  const daysRemaining = Math.max(0, (end - nowMs) / DAY_MS);
  const b24 = baseline(history, nowMs - DAY_MS), b7 = baseline(history, nowMs - 7 * DAY_MS);
  const burn24 = b24 ? Math.max(0, b24[3] - remaining) : null;
  const avg7 = b7 ? Math.max(0, b7[3] - remaining) / 7 : null;
  const rates = [burn24, avg7].filter((v): v is number => v !== null);
  const projected = rates.length ? FORECAST_MARGIN * Math.max(...rates) * daysRemaining : null;
  const threshold = remaining - RESERVE_HOURS;
  return {
    status: burn24 !== null && avg7 !== null ? "ok" : "insufficient_history",
    burn24hHours: burn24, avg7dDailyHours: avg7, daysRemaining, remainingHours: remaining,
    thresholdHours: threshold, projectedHours: projected,
    exceeds: burn24 === null || projected === null ? null : projected > threshold,
  };
}

function unavailable(accountId: string, reason: string, nowMs: number | null): CapacityReport {
  return {
    accountId, status: "unavailable", observedAt: nowMs === null ? null : new Date(nowMs).toISOString(), observedAtMs: nowMs,
    coverageMs: 0, reasons: [reason], warning: false, warningReasons: [], shouldNotify: false,
    plan: null, forecast: null, startPressure: null,
  };
}

function readDoc(raw: unknown): CapacityDoc {
  if (raw === null || raw === undefined) return { version: 1, accounts: {} };
  const d = obj(raw);
  const accounts = d && d.version === 1 ? obj(d.accounts) : null;
  if (!accounts) throw new Error("boat: capacity state unreadable");
  const out: CapacityDoc = { version: 1, accounts: {} };
  for (const [id, entry] of Object.entries(accounts)) {
    const a = obj(entry);
    if (!a || typeof a.seenAt !== "number" || !Array.isArray(a.samples)) continue;
    const samples = a.samples.filter((s): s is Sample =>
      Array.isArray(s) && s.length === 4 && s.every((n) => typeof n === "number" && Number.isFinite(n)))
      .sort((x, y) => x[0] - y[0]);
    const m = obj(a.marker);
    const marker = m && Array.isArray(m.reasons) && typeof m.lastNotifiedMs === "number"
      ? { reasons: m.reasons.filter((r): r is string => typeof r === "string"), lastNotifiedMs: m.lastNotifiedMs } : null;
    out.accounts[id] = { seenAt: a.seenAt, samples, marker, report: (obj(a.report) as unknown as CapacityReport) ?? null };
  }
  return out;
}

/** A stored reading older than 15 minutes is evidence only, never current. */
function markStale(r: CapacityReport, nowMs: number): CapacityReport {
  if (r.observedAtMs === null) return r; // already unavailable with no observation
  if (r.observedAtMs !== null && Number.isFinite(nowMs) && nowMs - r.observedAtMs <= STALE_AFTER_MS) return r;
  return { ...r, status: "unavailable", reasons: ["stale_observation", ...r.reasons.filter((x) => x !== "stale_observation")], shouldNotify: false };
}

function pruneAccounts(doc: CapacityDoc, nowMs: number): boolean {
  let changed = false;
  for (const [id, account] of Object.entries(doc.accounts)) {
    if (nowMs - account.seenAt > RETENTION_MS) {
      delete doc.accounts[id];
      changed = true;
      continue;
    }
    const samples = account.samples.filter((sample) => nowMs - sample[0] <= RETENTION_MS).slice(-MAX_SAMPLES);
    if (samples.length !== account.samples.length) {
      account.samples = samples;
      changed = true;
    }
  }
  return changed;
}

export class CapacityTelemetry {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: StateClientLike) {}

  /** Serialized per instance; one worker is the only writer, like VmStateStore. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private key(companyId: string) {
    return { scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey: STATE_KEY };
  }

  /** Record one observation and return the report. Never throws: failures become "unavailable". */
  sample(companyId: string, accountKey: string, rawLimits: unknown, nowMs: number): Promise<CapacityReport> {
    const accountId = digest(accountKey);
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
      return Promise.resolve(unavailable(accountId, "invalid_observation_time", null));
    }
    return this.serialize(async () => {
      try {
        return await this.sampleLocked(companyId, accountId, rawLimits, nowMs);
      } catch {
        return unavailable(accountId, "state_unavailable", nowMs);
      }
    });
  }

  private async sampleLocked(companyId: string, accountId: string, rawLimits: unknown, nowMs: number): Promise<CapacityReport> {
    const doc = readDoc(await this.state.get(this.key(companyId)));
    pruneAccounts(doc, nowMs);
    let acct = doc.accounts[accountId];
    const parsed = parseLimits(rawLimits);
    let report: CapacityReport;

    if (!parsed.ok) {
      report = unavailable(accountId, parsed.reason, nowMs);
    } else if (parsed.limits.periodEndMs <= nowMs) {
      report = unavailable(accountId, "plan_period_ended", nowMs);
    } else if (acct?.samples.length && nowMs < acct.samples[acct.samples.length - 1][0]) {
      report = unavailable(accountId, "clock_regression", nowMs);
    } else {
      const l = parsed.limits;
      const cur: Sample = [nowMs, l.periodEndMs, l.vmHours, l.vmHoursRemaining];
      if (!acct) acct = { seenAt: nowMs, samples: [], marker: null, report: null };
      acct.samples = acct.samples.filter((s) => nowMs - s[0] <= RETENTION_MS);
      const last = acct.samples[acct.samples.length - 1];
      // A different plan period/size or a balance that went up (top-up or
      // correction) invalidates the burn history; start over from this reading.
      if (last && (last[1] !== cur[1] || last[2] !== cur[2] || cur[3] > last[3] + EPS)) acct.samples = [];
      const history = acct.samples.filter((s) => s[0] < nowMs);
      const tail = acct.samples[acct.samples.length - 1];
      if (tail && nowMs - tail[0] < MIN_SAMPLE_SPACING_MS) { /* too close: report from it, do not store */ }
      else acct.samples = [...acct.samples.filter((s) => s[0] !== nowMs), cur].slice(-MAX_SAMPLES);

      const fc = buildForecast(history, cur, nowMs);
      const pressure = startPressureReasons(l);
      const warningReasons = [...pressure, ...(fc.exceeds ? ["vm_hours_forecast"] : [])];
      const reasons = [...warningReasons, ...(fc.status === "ok" ? [] : ["insufficient_history"])];
      const sorted = [...warningReasons].sort();
      const prev = acct.marker;
      let shouldNotify = false;
      if (sorted.length === 0) acct.marker = null;
      else if (!prev || prev.reasons.join() !== sorted.join() || nowMs - prev.lastNotifiedMs >= NOTIFY_REPEAT_MS) {
        shouldNotify = true;
        acct.marker = { reasons: sorted, lastNotifiedMs: nowMs };
      }
      report = {
        accountId, status: fc.status === "ok" ? "fresh" : "insufficient",
        observedAt: new Date(nowMs).toISOString(), observedAtMs: nowMs,
        coverageMs: nowMs - (history[0]?.[0] ?? nowMs),
        reasons, warning: warningReasons.length > 0, warningReasons, shouldNotify,
        plan: { periodEnd: new Date(l.periodEndMs).toISOString(), vmHours: l.vmHours, vmHoursRemaining: l.vmHoursRemaining },
        forecast: fc,
        startPressure: {
          pressure: pressure.length > 0, reasons: pressure, starts: l.starts,
          activeSandboxes: l.activeSandboxes, maxActiveSandboxes: l.maxActiveSandboxes, canStart: l.canStart,
        },
      };
    }

    // Unavailable keeps samples and the notify marker: it is never an all-clear.
    if (!acct) acct = { seenAt: nowMs, samples: [], marker: null, report: null };
    acct.seenAt = nowMs;
    acct.report = report;
    doc.accounts[accountId] = acct;
    const ids = Object.keys(doc.accounts);
    if (ids.length > MAX_ACCOUNTS) {
      ids.filter((id) => id !== accountId).sort((a, b) => doc.accounts[a].seenAt - doc.accounts[b].seenAt)
        .slice(0, ids.length - MAX_ACCOUNTS).forEach((id) => delete doc.accounts[id]);
    }
    try {
      await this.state.set(this.key(companyId), doc); // samples + marker + report in one write
    } catch {
      return { ...unavailable(accountId, "state_write_failed", nowMs) };
    }
    return report;
  }

  /** Scheduled maintenance still expires history when no verified source remains. */
  async maintain(companyId: string, nowMs: number): Promise<void> {
    await this.serialize(async () => {
      const doc = readDoc(await this.state.get(this.key(companyId)));
      if (pruneAccounts(doc, nowMs)) await this.state.set(this.key(companyId), doc);
    });
  }

  /** Last stored report per account (most recently seen first); reports older than 15 min are returned unavailable/stale_observation with their old evidence and observation time. */
  async latest(companyId: string, nowMs: number = Date.now()): Promise<CapacityReport[]> {
    const doc = readDoc(await this.state.get(this.key(companyId)));
    return Object.values(doc.accounts)
      .sort((a, b) => b.seenAt - a.seenAt)
      .flatMap((a) => (a.report ? [markStale(a.report, nowMs)] : []));
  }
}
