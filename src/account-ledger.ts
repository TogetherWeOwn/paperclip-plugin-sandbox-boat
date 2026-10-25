// One authoritative worker writes this instance-scoped account journal. The
// mutex fences pools and whole-run consumers, not unrelated provider clients.
import { createHash, randomUUID } from "node:crypto";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatSize } from "./config.js";
import { BoatProviderError, describeBoatError } from "./errors.js";
import type { StateClientLike } from "./state.js";
import { BoatBudgetError, checkBudget, readBudget } from "./budget.js";
import type { BudgetLimitName } from "./budget.js";

const WINDOWS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
type Window = keyof typeof WINDOWS;
// @boatdev/sdk 1.10 SandboxUsageResponse.billingMultiplier: seconds already
// include this multiplier. Never infer it from wall time or apply it twice.
const WEIGHT: Record<BoatSize, number> = { small: 0.5, default: 1, large: 2, xlarge: 50 / 9 };
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
}
interface StartWindow { used: number; limit: number; remaining: number; resetAt: number | null }
interface Limits {
  at: number;
  active: number;
  activeCap: number;
  canStart: boolean;
  available: number;
  used: number;
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
}
export interface AccountReservation { id: string; tailSeconds: number; at: number }

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
  const field = (key: string) => root[key] ?? nested[key] ?? pkg[key];
  const used = number(field("creditUsedSeconds"));
  const balance = number(field("creditBalanceSeconds"));
  const trial = field("trialComputeCapSeconds");
  const available = trial == null || trial === 0 ? balance : Math.min(balance, Math.max(0, number(trial) - used));
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
    available, used, windows, sizes: sizes as Limits["sizes"] };
}

async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider read timed out after 3 seconds")), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
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
  usage(poolId: string): AccountUsageRow[] { return structuredClone(this.rows.filter((r) => r.poolId === poolId)); }

  private async observe(api: BoatApiLike, doc: AccountDoc, allowCached = false, request?: AdmissionRequest): Promise<Limits> {
    const prior = this.observation(doc);
    const age = prior ? this.now() - prior.at : Infinity;
    if (allowCached && age >= 0 && age <= 5000) return prior!;
    let current: Limits;
    try {
      const raw = await bounded(() => api.limits({}));
      // Preserve an actionable refusal even for a partial exhausted response.
      // This legacy projection can only REFUSE; every admission still requires
      // the complete, finite strict snapshot below.
      if (request && request.operation !== "warm") {
        const refusal = checkBudget(readBudget(raw), request, request.size);
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
      let computeDelta = Math.max(0, current.used - prior.used, prior.available - current.available);
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
      if (!limits.canStart) refuse("boat_cannot_start", "provider refused admission");
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
    const machine = limits.sizes.find((s) => s.type === req.size);
    if (!machine?.available) refuse("machineType", "unavailable size");
    const committed = intents.reduce((sum, i) => sum + Math.max(0, i.compute - i.computeReflected), 0);
    if (limits.available - committed < (req.jobSeconds + tailSeconds) * WEIGHT[req.size] + req.minComputeHoursLeft * 3600) {
      refuse("minComputeHoursLeft", "insufficient job plus tail compute and reserve");
    }
  }
  private closeTail(doc: AccountDoc, sandboxId: string, at: number, includeUnscoped = false): void {
    for (const row of doc.usage) {
      if (!this.owns(row, includeUnscoped) || row.sandboxId !== sandboxId || row.tailSince == null) continue;
      if (at > row.tailSince) row.intervals.push({ since: new Date(row.tailSince).toISOString(), until: new Date(at).toISOString(), phase: "idle_tail" });
      row.tailSince = null;
      const intent = doc.intents.find((i) => i.usageId === row.usageRecordId);
      if (intent) { intent.endedAt = at; intent.compute = Math.min(intent.compute, Math.max(0, (at - intent.at) / 1000) * WEIGHT[intent.size]); }
    }
  }

  async reserve(api: BoatApiLike, req: AdmissionRequest): Promise<AccountReservation> {
    return await this.locked(async () => {
      const doc = await this.read();
      let limits = await this.observe(api, doc, req.allowCachedLimits, req);
      const tailSeconds = this.tail(doc, limits, req);
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
        tailSeconds, reserveSeconds: req.minComputeHoursLeft * 3600, endedAt: null, usageId: req.command ? id : null };
      candidate.intents.push(intent);
      if (req.command && req.poolId) candidate.usage.push({ usageRecordId: id, providerScope: this.providerScope, poolId: req.poolId, kind: "command",
        commandId: req.command.commandId, runId: req.command.runId, cardId: req.command.cardId, repoId: req.command.repoId,
        companyId: req.command.companyId, profileId: req.command.profileId, payloadDigest: req.command.payloadDigest,
        sandboxId: req.sandboxId ?? null, seconds: 0, dollars: 0, meterProvenance: "pending", observedStartsDelta: null, intervals: [], tailSince: null });
      await this.write(candidate);
      // Persistence may itself have waited for the store. Revalidate the exact
      // intent before any external effect if its observation aged out.
      if (this.now() - limits.at > 5000) {
        try {
          limits = await this.observe(api, candidate);
          this.check(candidate, limits, req, tailSeconds, id);
          await this.write(candidate);
          if (this.now() - limits.at > 5000) throw new Error("limits expired while persisting admission");
        } catch (error) {
          // No external effect occurred. Restore the predecessor's open tail;
          // the rejected handoff must not erase time that the old timer owns.
          await this.write(doc);
          throw error;
        }
      }
      return { id, tailSeconds, at };
    });
  }

  async revalidate(api: BoatApiLike, reservation: AccountReservation, req: AdmissionRequest): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      const limits = await this.observe(api, doc);
      this.check(doc, limits, req, reservation.tailSeconds, reservation.id);
      await this.write(doc);
      if (this.now() - limits.at > 5000) throw new Error("limits expired before retry");
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
    metadata: Pick<AccountUsageRow, "warm" | "queueWaitMs" | "exitCode" | "outcome" | "expectedSeconds" | "expectedDollars"> = {}): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read(), intent = doc.intents.find((i) => i.id === reservation.id)!;
      const at = this.now(), row = doc.usage.find((r) => r.usageRecordId === intent.usageId);
      if (row) {
        Object.assign(row, metadata);
        if (at > intent.at) row.intervals = [{ since: new Date(intent.at).toISOString(), until: new Date(at).toISOString(), phase: "command" }];
        row.tailSince = unknown ? null : at;
        row.seconds = Math.max(0, (at - intent.at) / 1000) * WEIGHT[intent.size];
        row.meterProvenance = "pending";
      }
      if (unknown) intent.status = "ambiguous";
      else intent.compute = Math.max(0, (at - intent.at) / 1000 + intent.tailSeconds) * WEIGHT[intent.size];
      await this.write(doc);
    });
  }

  async stopped(sandboxId: string): Promise<void> {
    await this.locked(async () => {
      const doc = await this.read();
      this.terminal(doc, sandboxId, this.now());
      await this.write(doc);
    });
  }
  private terminal(doc: AccountDoc, sandboxId: string, at: number, includeUnscoped = false): void {
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

  async reconcile(api: BoatApiLike, inventory?: ReadonlyArray<{ id: string; state: string }>, allowCachedLimits = false, includeUnscoped = false): Promise<void> {
    const ids = await this.locked(async () => {
      const doc = await this.read();
      try { await this.observe(api, doc, allowCachedLimits); } catch { /* Never free a reservation on unreadable limits. */ }
      const owned = doc.intents.filter((i) => this.owns(i, includeUnscoped));
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
