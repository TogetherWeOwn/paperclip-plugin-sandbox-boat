import { expect, vi } from "vitest";
import { OffloadExecutor } from "../offload.js";
import type { OffloadCommand, OffloadDeps, OffloadExecutorConfig } from "../offload.js";
import { BoatVmManager } from "../vm-manager.js";
import type { ManagerDeps } from "../vm-manager.js";
import { setBoatApiFactoryForTests } from "../boat-client.js";
import type { BoatApiLike } from "../boat-client.js";
import type { StateClientLike } from "../state.js";
import { FakeBoat, trialLimits } from "./fake-boat.js";
import { FakeSsh } from "./harness.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

/*
 * Independently owned acceptance seam, not a proposed ledger implementation.
 * Existing public execute/acquire/getUsage/SDK methods remain the entry points.
 * Minimal new dependencies on OffloadDeps: state (existing StateClientLike),
 * accountId (opaque credential-free provider-account identity), poolId (stable
 * pool identity). ManagerDeps receives the same accountId and existing state.
 * New public reconcile(): one bounded sweep/reconciliation pass, also usable by
 * the worker's existing sweep. No new HTTP route or live-dispatch wiring.
 *
 * Serialization, mutex implementation and internal ledger classes are NOT
 * prescribed. Restart tests copy only committed JSON state into a new client;
 * aliases to mutable objects and process-local reservations cannot satisfy them.
 * resetAt in synthetic limits is optional provider metadata (a Date), not an
 * SDK 1.10 field: adapters must preserve/normalize it when supplied. SDK 1.10's
 * documented windows are rolling, so missing metadata is NEVER UTC midnight.
 */
type AdmissionDeps = OffloadDeps & { state: StateClientLike; accountId: string; poolId: string };
type AccountManagerDeps = ManagerDeps & { accountId: string };

export const EPOCH = Date.parse("2026-10-23T23:59:50Z");
let nextAccount = 0;
const accounts = new WeakMap<FakeBoat, string>();
export const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
export const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class JsonState implements StateClientLike {
  readonly rows = new Map<string, string>();
  writes = 0;
  failWrites = false;
  beforeWrite: (() => Promise<void>) | undefined;
  constructor(snapshot: Array<[string, string]> = []) { for (const row of snapshot) this.rows.set(...row); }
  private key(input: Parameters<StateClientLike["get"]>[0]) { return JSON.stringify([input.scopeKind, input.scopeId ?? null, input.namespace ?? null, input.stateKey]); }
  async get(input: Parameters<StateClientLike["get"]>[0]) { return JSON.parse(this.rows.get(this.key(input)) ?? "null"); }
  async set(input: Parameters<StateClientLike["set"]>[0], value: unknown) {
    if (this.failWrites) throw new Error("synthetic durable store unavailable");
    await this.beforeWrite?.();
    this.rows.set(this.key(input), JSON.stringify(value));
    this.writes += 1;
  }
  snapshot(): Array<[string, string]> { return [...this.rows]; }
}

export function command(commandId: string, partial: Partial<OffloadCommand> = {}): OffloadCommand {
  return { commandId, companyId: COMPANY, runId: `run-${commandId}`, cardId: `card-${commandId}`,
    repoId: "public-source", profileId: "rust-secret-free", argv: ["test", "--locked"],
    timeoutMs: 60_000, queueTimeoutMs: 1, ...partial };
}

export function limits(overrides: Record<string, unknown> = {}) {
  return trialLimits({ creditBalanceSeconds: 90_000, creditUsedSeconds: 0,
    creditSecondsPerDollar: 100_000, ...overrides });
}
export function starts(dayUsed = 0, dayLimit = 75) {
  return { unlimited: false, minute: { limit: 5, used: 0, remaining: 5 },
    hour: { limit: 25, used: 0, remaining: 25 }, day: { limit: dayLimit, used: dayUsed, remaining: dayLimit - dayUsed } };
}

interface Constructors {
  Offload: typeof OffloadExecutor;
  Manager: typeof BoatVmManager;
  setBoat: typeof setBoatApiFactoryForTests;
}
export function fixture(snapshot: Array<[string, string]> = [], existingBoat?: FakeBoat,
  constructors: Constructors = { Offload: OffloadExecutor, Manager: BoatVmManager, setBoat: setBoatApiFactoryForTests }) {
  const state = new JsonState(snapshot);
  const boat = existingBoat ?? new FakeBoat({ now: () => Date.now() });
  if (!accounts.has(boat)) accounts.set(boat, `synthetic-account-${++nextAccount}`);
  const accountId = accounts.get(boat)!;
  if (!existingBoat) boat.limitsResponse = limits();
  const ssh = new FakeSsh();
  spawnMock.mockImplementation(ssh.spawn);
  constructors.setBoat(() => boat as unknown as BoatApiLike);
  const logs: unknown[] = [];
  const logger = { info: (...args: unknown[]) => { logs.push(args); },
    warn: (...args: unknown[]) => { logs.push(args); }, error: (...args: unknown[]) => { logs.push(args); } };
  const executions: string[] = [];
  const blockers: Array<() => void> = [];
  const pools: OffloadExecutor[] = [];
  const managers: BoatVmManager[] = [];
  function gate() {
    const d = deferred<void>(); blockers.push(() => d.resolve()); return d;
  }
  function pool(poolId = "pool-a", config: Partial<OffloadExecutorConfig> = {},
    run?: OffloadDeps["runCommand"], providerAccount = accountId) {
    const deps: AdmissionDeps = { boat: boat as unknown as BoatApiLike, state, accountId: providerAccount, poolId,
      now: () => Date.now(), logger,
      timers: { set: (cb, ms) => setTimeout(cb, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
      config: { maxOffloadVms: 4, offloadIdleStopSeconds: 15, ...config },
      runCommand: async (id, cmd) => { executions.push(cmd.commandId); return run ? run(id, cmd) : { exitCode: 0, seconds: 0 }; } };
    const executor = new constructors.Offload(deps); pools.push(executor); return executor;
  }
  function manager() {
    const deps: AccountManagerDeps = { state, accountId, logger, now: () => Date.now(),
      sleep: async (ms) => { await advance(ms); } };
    const result = new constructors.Manager(deps); managers.push(result); return result;
  }
  function acquire(manager: BoatVmManager, id = "whole-run", config: Record<string, unknown> = {}) {
    return manager.acquire({ driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT,
      issueId: `issue-${id}`, executionWorkspaceId: `workspace-${id}`, runId: id, agentId: "synthetic-principal",
      config: { apiKey: "boat_synthetic_not_a_credential", cliproxyTunnel: false, ...config } } as never);
  }
  async function close() {
    state.failWrites = false;
    state.beforeWrite = undefined;
    blockers.forEach((release) => release());
    await advance(31_000);
    await Promise.all(pools.map((p) => p.shutdown()));
    await Promise.all(managers.map((m) => m.shutdown()));
    constructors.setBoat(null);
  }
  return { state, boat, accountId, logger, logs, executions, gate, pool, manager, acquire, close };
}

export async function restart(prior: ReturnType<typeof fixture>) {
  // Reload the real consumers and their ledger module, not merely their
  // constructors: process-global caches must not substitute for durable state.
  const snapshot = prior.state.snapshot();
  vi.resetModules();
  const [offload, manager, client] = await Promise.all([
    import("../offload.js"), import("../vm-manager.js"), import("../boat-client.js"),
  ]);
  return fixture(snapshot, prior.boat, { Offload: offload.OffloadExecutor, Manager: manager.BoatVmManager, setBoat: client.setBoatApiFactoryForTests });
}

export function safeRefusal(result: unknown) {
  expect(result).toMatchObject({ status: "unavailable", code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
}
export function noDispatch(f: ReturnType<typeof fixture>) {
  expect(f.boat.callsOf("create")).toHaveLength(0);
  expect(f.boat.callsOf("resume")).toHaveLength(0);
  expect(f.executions).toEqual([]);
}

export async function reconcile(executor: OffloadExecutor) {
  const boundary = executor as unknown as { reconcile?: () => Promise<void> };
  expect(boundary.reconcile, "bounded persisted-ledger reconciliation must be available to the worker sweep").toBeTypeOf("function");
  await boundary.reconcile!();
}

// Usage projection extends getUsage(), not a second test-only inspection API.
// intervals are wall-clock half-open [since, until); seconds are SDK-weighted.
export interface AccountUsage {
  usageRecordId: string;
  kind: "command" | "failed_start" | "aborted_start" | "overhead";
  commandId: string | null;
  sandboxId: string | null;
  seconds: number;
  dollars: number;
  meterProvenance: "estimate" | "provider" | "pending";
  observedStartsDelta: number | null;
  intervals: Array<{ since: string; until: string; phase: "command" | "idle_tail" | "overhead" }>;
}
export function usage(executor: OffloadExecutor) { return executor.getUsage() as unknown as AccountUsage[]; }

export function providerMeter(f: ReturnType<typeof fixture>, seconds: number, dollars: number,
  options: { unavailable?: boolean; running?: boolean; since?: number; until?: number; multiplier?: number; secondsPerDollar?: number } = {}) {
  f.boat.usage = async (args: Record<string, unknown>) => {
    f.boat.calls.push({ method: "usage", args });
    if (options.unavailable) throw new Error("synthetic meter unavailable");
    const box = f.boat.boxes.get(String(args.sandboxId));
    const fullSince = options.since ?? EPOCH, fullUntil = options.until ?? Date.now();
    const timestamp = (value: unknown, fallback: number) => value == null ? fallback : new Date(value as string).getTime();
    const since = Math.max(fullSince, timestamp(args.since, fullSince));
    const until = Math.min(fullUntil, Date.now(), timestamp(args.until, Date.now()));
    const fraction = fullUntil > fullSince ? Math.max(0, until - since) / (fullUntil - fullSince) : 0;
    return { ok: true, type: "sandbox.usage", sandboxId: String(args.sandboxId), sandboxType: box?.type ?? "default",
      billingMultiplier: options.multiplier ?? 1, seconds: seconds * fraction, dollars: dollars * fraction, secondsPerDollar: options.secondsPerDollar ?? 100_000,
      since: new Date(since), until: new Date(Math.max(since, until)), running: options.running ?? false };
  };
}
