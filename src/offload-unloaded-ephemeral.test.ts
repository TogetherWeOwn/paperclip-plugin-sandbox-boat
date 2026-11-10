// Public SshOffloadRuntime.sweep after a restart, for an unloaded pool whose VM
// persisted deleteOnRelease before execution. Every case restarts from durable
// state only: no resolve, no executor load, no command, no provider create.
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoatApiLike } from "./boat-client.js";
import { DEFAULT_API_BASE, parseDriverConfig } from "./config.js";
import { AccountLedger } from "./account-ledger.js";
import { commandDigest } from "./offload-journal.js";
import { OffloadPoolStore, type PoolVm } from "./offload-pool.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { FakeBoat, responseError } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";

const companyId = "company-unloaded-ephemeral";
const accountId = "account-unloaded-ephemeral";
const poolId = "pool-unloaded-ephemeral";
const sandboxId = "bx_unloadedephem01";
const runId = "run-unloaded-ephemeral";
const commandId = "cmd-unloaded-ephemeral";
const fakeKey = "boat_test_key_not_real";
const baseConfig = { apiKey: fakeKey, cliproxyTunnel: false };
const recordKey = `command/${companyId}/${runId}/${commandId}`;
const poolDigest = scryptSync(fakeKey, `boat-offload-pool\u0000${DEFAULT_API_BASE}`, 32).toString("hex");
const registryScope = { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" };
const journalScope = (stateKey: string) =>
  ({ scopeKind: "company" as const, scopeId: companyId, namespace: `boat-executor-${poolId}`, stateKey });

type JournalKind = "completed" | "running" | "syncing_out";
type Provider = "archived" | "ready" | "gone";
type StateInput = Parameters<ReturnType<typeof createFakeContext>["ctx"]["state"]["set"]>[0];

let fake: FakeBoat;
let clock: number;
let harness: ReturnType<typeof createFakeContext>;
let runtimes: SshOffloadRuntime[];
let restore: Array<() => void>;

beforeEach(() => {
  clock = Date.now();
  fake = new FakeBoat({ now: () => clock });
  harness = createFakeContext();
  runtimes = [];
  restore = [];
});
afterEach(async () => {
  for (const undo of restore.reverse()) undo();
  for (const runtime of runtimes) await runtime.shutdown().catch(() => undefined);
});

const api = () => fake as unknown as BoatApiLike;
const poolStore = () => new OffloadPoolStore(harness.ctx.state, accountId, poolId);

/** A worker restart: a brand-new runtime over the same durable state, nothing resolved or loaded. */
function restart() {
  const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: {} as never,
    accountId, boat: () => api() });
  runtimes.push(runtime);
  return runtime;
}
const sweep = (runtime: SshOffloadRuntime) =>
  runtime.sweep([companyId], { configsFor: () => [parseDriverConfig(baseConfig)] });
const swallow = (runtime: SshOffloadRuntime) => sweep(runtime).then(() => null, (error: unknown) => error);

/** Fail matching state writes (reads and other namespaces keep working). */
function failWrites(namespace: string, when: () => boolean = () => true) {
  const realSet = harness.ctx.state.set.bind(harness.ctx.state);
  harness.ctx.state.set = (async (input: StateInput, value: unknown) => {
    if (input.namespace === namespace && when()) throw new Error(`synthetic ${namespace} write failure`);
    return realSet(input, value);
  }) as typeof harness.ctx.state.set;
  restore.push(() => { harness.ctx.state.set = realSet; });
  return () => { harness.ctx.state.set = realSet; };
}

const readJournal = async () => await harness.ctx.state.get(journalScope(recordKey)) as
  { state: string; resultAt: number | null } | null;
const intent = () => {
  const doc = [...harness.state.entries()].find(([key]) => key.includes("|boat-account|"))?.[1] as {
    intents: Array<{ sandboxId: string | null; active: boolean; status: string }>;
  } | undefined;
  return doc?.intents.find((entry) => entry.sandboxId === sandboxId);
};
const deletes = () => fake.callsOf("deleteSandbox").map((call) => call.args.sandboxId);

interface SeedOptions {
  journal?: JournalKind | "none";
  provider?: Provider;
  deleteOnRelease?: boolean;
  deletePending?: boolean;
}
/** Persist what a crashed worker leaves behind. The pre-execution policy is saved; deletion is not yet pending. */
async function seed(options: SeedOptions = {}) {
  const { journal = "completed", provider = "archived", deleteOnRelease = true, deletePending = false } = options;
  const ledger = new AccountLedger(harness.ctx.state, accountId, () => clock);
  const reservation = await ledger.reserve(api(), { operation: "create", poolId, size: "default",
    jobSeconds: 60, tailSeconds: 15, maxActive: 2, maxStartsPerDay: 75, minComputeHoursLeft: 0,
    command: { commandId, runId, cardId: "card", repoId: "repo", companyId } });
  await ledger.started(api(), reservation, sandboxId);
  if (journal === "completed") await ledger.finished(reservation, false, { outcome: "completed", exitCode: 0 });
  if (provider !== "gone") fake.addSandbox({ id: sandboxId, state: provider });

  const command = { companyId, runId, commandId };
  const digest = commandDigest(command as never);
  const identity = { companyId, runId, commandId, digest, sandboxId, guestBootId: "boot-1", journalGeneration: 1 };
  if (journal !== "none") {
    await harness.ctx.state.set(journalScope("index"), [recordKey]);
    await harness.ctx.state.set(journalScope(recordKey), {
      version: 1, companyId, runId, commandId, command, digest, state: journal, identity,
      acceptedAt: clock, updatedAt: clock,
      resultAt: journal === "completed" ? clock : null,
      result: journal === "completed" ? { status: "completed", commandId, exitCode: 0, seconds: 1, sandboxId,
        remoteStarted: true, fallbackSafe: false } : null,
      remoteStarted: true, fallbackSafe: false,
    });
  }
  const vm: PoolVm = { sandboxId, busy: true, stopped: false, stopping: false, quarantined: false,
    ...(deleteOnRelease ? { deleteOnRelease: true } : {}), ...(deletePending ? { quarantined: true, deletePending: true } : {}),
    lastActiveAt: clock - 60_000, generation: 1, idleHandle: null, stopDueAt: null, stopRequestedAt: null,
    stopAttempts: 0, identity, accountReservation: reservation };
  await poolStore().save({ maxOffloadVms: 1, offloadIdleStopSeconds: 15 }, [vm]);
  await harness.ctx.state.set(registryScope, { [poolId]: { artifactRoot: "/tmp/paperclip-unloaded-ephemeral-artifacts",
    seenAt: clock, credentialDigest: poolDigest } });
  return { reservation, ledger };
}

/** Record durable pool, journal and ledger state at each DELETE and at the write that removes ownership. */
function observe() {
  const atDelete: Array<{ vm: PoolVm | undefined }> = [];
  const atRemoval: Array<{ journal: { state: string; resultAt: number | null } | null; intent: ReturnType<typeof intent> }> = [];
  const realDelete = fake.deleteSandbox.bind(fake);
  fake.deleteSandbox = async (args: Record<string, unknown>) => {
    atDelete.push({ vm: (await poolStore().load()).find((entry) => entry.sandboxId === sandboxId) });
    return realDelete(args);
  };
  const realSet = harness.ctx.state.set.bind(harness.ctx.state);
  harness.ctx.state.set = (async (input: StateInput, value: unknown) => {
    if (input.namespace === "boat-offload-pool"
      && !(value as { vms: PoolVm[] }).vms.some((entry) => entry.sandboxId === sandboxId)) {
      atRemoval.push({ journal: await readJournal(), intent: intent() });
    }
    return realSet(input, value);
  }) as typeof harness.ctx.state.set;
  restore.push(() => { harness.ctx.state.set = realSet; fake.deleteSandbox = realDelete; });
  return { atDelete, atRemoval };
}

/** Sweep until ownership is gone; implementations may take several sweeps. Never exceeds a small bound. */
async function drain(runtime: SshOffloadRuntime, max = 4) {
  for (let n = 0; n < max; n += 1) {
    await swallow(runtime);
    if ((await poolStore().load()).length === 0) return;
  }
}
const noNewWork = () => {
  for (const method of ["create", "fork", "resume", "stop"] as const) expect(fake.callsOf(method)).toEqual([]);
};
const terminalFor = (journal: JournalKind) => journal === "completed" ? "completed" : "unknown";

describe("unloaded ephemeral pool sweep after restart", () => {
  it.each(["completed", "running", "syncing_out"] as const)(
    "durably queues deletion before DELETE and settles journal and ledger before ownership is removed (%s journal, archived provider)",
    async (journal) => {
      await seed({ journal });
      const seen = observe();
      await drain(restart());
      expect(seen.atDelete).toHaveLength(1);
      expect(seen.atDelete[0]!.vm).toMatchObject({ sandboxId, quarantined: true, deletePending: true, deleteOnRelease: true });
      expect(seen.atRemoval.length).toBeGreaterThan(0);
      for (const snapshot of seen.atRemoval) {
        expect(snapshot.journal).toMatchObject({ state: terminalFor(journal), resultAt: expect.any(Number) });
        expect(snapshot.intent).toMatchObject({ active: false, status: "stopped" });
      }
      expect(await poolStore().load()).toEqual([]);
      expect(deletes()).toEqual([sandboxId]);
      noNewWork();
      expect(await new AccountLedger(harness.ctx.state, accountId, () => clock).poolAccountingSettled(poolId)).toBe(true);
    });

  it("deletes a still-running provider VM once a completed journal gives completion authority", async () => {
    await seed({ journal: "completed", provider: "ready" });
    const seen = observe();
    await drain(restart());
    expect(seen.atDelete).toHaveLength(1);
    expect(seen.atDelete[0]!.vm).toMatchObject({ sandboxId, quarantined: true, deletePending: true, deleteOnRelease: true });
    expect(deletes()).toEqual([sandboxId]);
    expect(await poolStore().load()).toEqual([]);
    for (const snapshot of seen.atRemoval) {
      expect(snapshot.journal).toMatchObject({ state: "completed" });
      expect(snapshot.intent).toMatchObject({ active: false, status: "stopped" });
    }
    noNewWork();
  });

  it.each(["completed", "running"] as const)("is idempotent across repeated sweeps and another restart (%s journal)", async (journal) => {
    await seed({ journal });
    const first = restart();
    await drain(first);
    expect(await poolStore().load()).toEqual([]);
    await swallow(first);
    await swallow(restart());
    await swallow(restart());
    expect(deletes()).toEqual([sandboxId]);
    expect(await readJournal()).toMatchObject({ state: terminalFor(journal) });
    expect(intent()).toMatchObject({ active: false, status: "stopped" });
    noNewWork();
  });

  it("never deletes a non-ephemeral archived VM: control keeps the stopped-slot behavior", async () => {
    await seed({ deleteOnRelease: false });
    await drain(restart(), 2);
    expect(deletes()).toEqual([]);
    expect(await poolStore().load()).toMatchObject([{ sandboxId, stopped: true }]);
    noNewWork();
  });

  describe("controls", () => {
    it.each(["missing", "foreign", "endpoint"] as const)("requires matching credential and endpoint provenance (%s)", async (mode) => {
      await seed();
      await harness.ctx.state.set(registryScope, { [poolId]: {
        artifactRoot: "/tmp/paperclip-unloaded-ephemeral-artifacts", seenAt: clock,
        ...(mode === "missing" ? {} : { credentialDigest: mode === "foreign" ? "0".repeat(64) : poolDigest }),
      } });
      const runtime = restart();
      await runtime.sweep([companyId], { configsFor: () => [parseDriverConfig({ ...baseConfig,
        ...(mode === "endpoint" ? { apiBase: "https://unrelated.example.invalid/api" } : {}),
      })] });
      expect(deletes()).toEqual([]);
      expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true }]);
      expect((await poolStore().load())[0]!.deletePending).toBeFalsy();
      noNewWork();
    });

    it.each(["running", "syncing_out"] as const)(
      "does not delete or stop a live provider VM while its %s journal is unfinished", async (journal) => {
        await seed({ journal, provider: "ready" });
        const runtime = restart();
        await swallow(runtime);
        await swallow(restart());
        expect(deletes()).toEqual([]);
        noNewWork();
        expect(await readJournal()).toMatchObject({ state: journal, resultAt: null });
        expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true }]);
        expect((await poolStore().load())[0]!.deletePending).toBeFalsy();
        expect(intent()).toMatchObject({ active: true });
      });

    it("keeps ownership and sends no DELETE while the journal is unreadable, then deletes after repair", async () => {
      await seed({ journal: "completed" });
      const good = await readJournal();
      await harness.ctx.state.set(journalScope(recordKey), { version: 2, garbage: true });
      const seen = observe();
      const runtime = restart();
      await swallow(runtime);
      await swallow(runtime);
      expect(seen.atDelete).toEqual([]);
      expect(deletes()).toEqual([]);
      expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true }]);
      expect(seen.atRemoval).toEqual([]);
      await harness.ctx.state.set(journalScope(recordKey), good);
      await drain(restart());
      expect(await poolStore().load()).toEqual([]);
      expect(deletes()).toEqual([sandboxId]);
    });

    it("keeps ownership and sends zero DELETE when the pool write fails before deletion is durable", async () => {
      await seed({ journal: "running" });
      const heal = failWrites("boat-offload-pool");
      const runtime = restart();
      await swallow(runtime);
      await swallow(runtime);
      expect(deletes()).toEqual([]);
      expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true }]);
      heal();
      const seen = observe();
      await drain(restart());
      expect(seen.atDelete[0]!.vm).toMatchObject({ quarantined: true, deletePending: true });
      expect(deletes()).toEqual([sandboxId]);
      expect(await poolStore().load()).toEqual([]);
    });

    it.each(["running", "syncing_out"] as const)(
      "retains ownership when the journal fails before terminal settlement (%s, deletion not yet pending)", async (journal) => {
        await seed({ journal });
        const heal = failWrites(`boat-executor-${poolId}`);
        const runtime = restart();
        await swallow(runtime);
        await swallow(runtime);
        expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true, quarantined: true }]);
        expect(await readJournal()).toMatchObject({ state: journal, resultAt: null });
        heal();
        const seen = observe();
        await drain(restart());
        expect(await poolStore().load()).toEqual([]);
        for (const snapshot of seen.atRemoval) expect(snapshot.journal).toMatchObject({ state: "unknown", resultAt: expect.any(Number) });
        expect(await readJournal()).toMatchObject({ state: "unknown", resultAt: expect.any(Number) });
        expect(intent()).toMatchObject({ active: false, status: "stopped" });
        noNewWork();
      });

    it.each([
      ["running", "archived"], ["syncing_out", "archived"], ["running", "gone"], ["syncing_out", "gone"],
    ] as const)(
      "keeps the retry anchor when the journal fails after an existing pending DELETE (%s journal, %s provider: DELETE or 404)",
      async (journal, provider) => {
        await seed({ journal, provider, deletePending: true });
        const heal = failWrites(`boat-executor-${poolId}`);
        const runtime = restart();
        await swallow(runtime);
        await swallow(runtime);
        // Existing semantics may DELETE before journal settlement, but the
        // pending owner and quarantine must remain until the journal settles.
        expect(await poolStore().load()).toMatchObject([{ sandboxId, quarantined: true, deletePending: true }]);
        expect(await readJournal()).toMatchObject({ state: journal, resultAt: null });
        heal();
        const seen = observe();
        await drain(restart());
        expect(await poolStore().load()).toEqual([]);
        expect(await readJournal()).toMatchObject({ state: "unknown", resultAt: expect.any(Number) });
        for (const snapshot of seen.atRemoval) {
          expect(snapshot.journal).toMatchObject({ state: "unknown", resultAt: expect.any(Number) });
          expect(snapshot.intent).toMatchObject({ active: false, status: "stopped" });
        }
        noNewWork();
      });

    it.each(["completed", "running"] as const)(
      "retains ownership while the ledger write fails and removes it only after the ledger settles (%s journal)", async (journal) => {
        await seed({ journal });
        const heal = failWrites("boat-account");
        const runtime = restart();
        await swallow(runtime);
        await swallow(runtime);
        expect(await poolStore().load()).toMatchObject([{ sandboxId, deleteOnRelease: true }]);
        expect(intent()?.status).not.toBe("stopped");
        heal();
        const seen = observe();
        await drain(restart());
        expect(await poolStore().load()).toEqual([]);
        for (const snapshot of seen.atRemoval) expect(snapshot.intent).toMatchObject({ active: false, status: "stopped" });
        expect(intent()).toMatchObject({ active: false, status: "stopped" });
        noNewWork();
      });

    it("retries after a DELETE outage with the pending owner durable, then removes ownership", async () => {
      await seed({ journal: "completed" });
      fake.failNext("deleteSandbox", new Error("synthetic DELETE outage"));
      const runtime = restart();
      await swallow(runtime);
      expect(await poolStore().load()).toMatchObject([{ sandboxId, quarantined: true, deletePending: true, deleteOnRelease: true }]);
      expect(fake.boxes.has(sandboxId)).toBe(true);
      await drain(restart());
      expect(await poolStore().load()).toEqual([]);
      expect(fake.boxes.has(sandboxId)).toBe(false);
      expect(deletes()).toEqual([sandboxId, sandboxId]);
      expect(intent()).toMatchObject({ active: false, status: "stopped" });
      noNewWork();
    });

    it("treats a DELETE 404 as deleted and settles before removing ownership", async () => {
      await seed({ journal: "running" });
      fake.failNext("deleteSandbox", responseError(404, { code: "not_found", message: "sandbox not found" }));
      const seen = observe();
      await drain(restart());
      expect(await poolStore().load()).toEqual([]);
      expect(seen.atDelete[0]!.vm).toMatchObject({ quarantined: true, deletePending: true });
      for (const snapshot of seen.atRemoval) {
        expect(snapshot.journal).toMatchObject({ state: "unknown", resultAt: expect.any(Number) });
        expect(snapshot.intent).toMatchObject({ active: false, status: "stopped" });
      }
      noNewWork();
    });

    it("lets a claim that interleaves with the sweep win before any new deletion intent is saved", async () => {
      await seed({ journal: "completed" });
      const store = poolStore();
      const realGet = harness.ctx.state.get.bind(harness.ctx.state);
      let injected = false;
      harness.ctx.state.get = async (input) => {
        // Completion can authorize DELETE without a provider GET. Interleave
        // while reading its journal, before the intent's fresh-snapshot check.
        if (!injected && input.namespace === `boat-executor-${poolId}` && input.stateKey === recordKey) {
          injected = true;
          const doc = await store.loadDoc();
          const vm = doc.vms.find((entry) => entry.sandboxId === sandboxId)!;
          vm.busy = true;
          vm.generation += 1;
          await store.save(doc.config, doc.vms);
        }
        return realGet(input);
      };
      restore.push(() => { harness.ctx.state.get = realGet; });
      await swallow(restart());
      expect(deletes()).toEqual([]);
      const [vm] = await store.load();
      expect(vm).toMatchObject({ sandboxId, busy: true, generation: 2, deleteOnRelease: true });
      expect(vm!.deletePending).toBeFalsy();
      noNewWork();
    });
  });
});
