import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, fixture, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";
import { OffloadExecutor } from "./offload.js";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";
import { SshOffloadGuest } from "./offload-ssh.js";
import type { ExecutionIdentity } from "./offload-lifecycle.js";

// In-memory journal disk for the 10k-command run: the file-backed DiskState
// rewrites the whole document per write (quadratic), and all() feeds only the
// fixture's starts[] observation snapshot, so it returns {} to keep the run
// linear. Otherwise this is the real storage with value semantics.
class MemDisk {
  private readonly doc = new Map<string, unknown>();
  async all(): Promise<Record<string, unknown>> { return {}; }
  private ck(input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) {
    return JSON.stringify([input.scopeKind, input.scopeId ?? null, input.namespace ?? null, input.stateKey]);
  }
  private parsed(key: string) {
    const [, , namespace, stateKey] = JSON.parse(key) as [string, string | null, string | null, string];
    return { namespace, stateKey };
  }
  async get(input: Parameters<MemDisk["set"]>[0]) {
    const value = this.doc.get(this.ck(input));
    return value === undefined ? null : structuredClone(value);
  }
  async set(input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) {
    this.doc.set(this.ck(input), structuredClone(value));
  }
  async delete(input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) {
    this.doc.delete(this.ck(input));
  }
  store() {
    const key = (stateKey: string) => ({ scopeKind: "instance" as const, namespace: "guest-test-journal", stateKey });
    return {
      get: (id: string) => this.get(key(id)),
      set: (id: string, value: unknown) => this.set(key(id), value),
      create: async (id: string, value: unknown) => {
        if (await this.get(key(id)) !== null) return false;
        await this.set(key(id), value);
        return true;
      },
      delete: (id: string) => this.delete(key(id)),
      list: async (prefix: string) => [...this.doc.keys()].map((entry) => this.parsed(entry))
        .filter((id) => id.namespace === "guest-test-journal" && id.stateKey.startsWith(prefix))
        .map((id) => id.stateKey),
    };
  }
}

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

function executorMaps(executor: object) {
  return executor as unknown as {
    journal: Map<string, unknown>;
    knownCommands: Map<string, unknown>;
    lifecycle: { active: Map<string, unknown>; watchdogPaths: Set<string> } | null;
  };
}

describe("offload in-memory pruning", () => {
  it("10,000 commands drain the volatile journal, ID lookups and watchdog paths", async () => {
    // Batched into fresh executor+disk pairs: the billing ledger intentionally
    // retains its durable audit rows per command (kept for accounting), so one
    // shared disk would measure ledger cloning instead of map drainage. Every
    // batch still runs the full guest lifecycle to terminal receipts. Watchdog
    // paths stay pinned while their VM boot is alive (a delayed guest watchdog
    // must never meet a recycled path), so each batch shuts its VM down first:
    // shutdown stops the VM and releases its paths, and the maps must all read
    // zero afterwards.
    for (let batch = 0; batch < 40; batch += 1) {
      const executor = s.make({}, new MemDisk() as never);
      for (let i = 0; i < 250; i += 1) {
        const n = batch * 250 + i;
        await executor.execute(command(`prune-${n}`, { runId: `prune-run-${n}` }));
      }
      await executor.shutdown();
      const maps = executorMaps(executor);
      expect(maps.journal.size).toBe(0);
      expect(maps.knownCommands.size).toBe(0);
      expect(maps.lifecycle?.active.size ?? 0).toBe(0);
      expect(maps.lifecycle?.watchdogPaths.size ?? -1).toBe(0);
    }
  }, 300_000);

  it("a live command survives 512 completions without losing its journal entry", async () => {
    // The non-durable journal retains settled receipts for idempotent replays
    // and caps itself at 512 entries. The cap must evict settled receipts
    // only: a live entry backs in-flight work, and finish() throws when it is
    // gone, skipping the ledger close and the VM release while duplicates
    // re-run. A legacy (guest-free) executor exercises the volatile path.
    let releaseLong!: () => void;
    const longGate = new Promise<void>((resolve) => { releaseLong = resolve; });
    let longStarted = false;
    const ex = new OffloadExecutor({
      state: s.state,
      accountId: "volatile-journal-test",
      poolId: "volatile-journal-pool",
      boat: s.boat as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: s.clock.now,
      timers: { set: s.clock.set, clear: s.clock.clear },
      config: { maxOffloadVms: 2, offloadIdleStopSeconds: 3600 },
      runCommand: async (_sandboxId: string, cmd) => {
        if (cmd.commandId === "long-lived") { longStarted = true; await longGate; }
        return { exitCode: 0, seconds: 1 };
      },
    });
    // Separate workspaces: same-workspace commands queue behind the busy VM
    // instead of running beside it, which would never complete the shorts.
    const longPending = ex.execute(command("long-lived", { executionWorkspaceId: "workspace-long" }));
    await until(() => longStarted);
    for (let n = 0; n < 512; n += 1) {
      await ex.execute(command(`short-${n}`, { executionWorkspaceId: "workspace-shorts" }));
    }
    releaseLong();
    await expect(longPending).resolves.toMatchObject({ status: "completed" });
    const maps = executorMaps(ex);
    const live = maps.journal.get("long-lived") as { result: unknown } | undefined;
    expect(live?.result).toMatchObject({ status: "completed" });
    expect(maps.journal.size).toBeLessThanOrEqual(512);
    // The VM was released, not stuck busy behind a journal throw.
    await expect(ex.execute(command("after", { executionWorkspaceId: "workspace-long" }))).resolves.toMatchObject({ status: "completed" });
    await ex.shutdown();
  }, 180_000);

  it("a duplicate joins a command still in post-finish accounting", async () => {
    // finish() records the result before accounting, duration recording and
    // VM release finish. Another command's cap eviction must not delete that
    // entry while its promise is still pending: the duplicate would
    // re-execute beside the first call, and the settling call would then
    // delete the duplicate's inFlight join so a later duplicate fails.
    const runs: string[] = [];
    let accountingEntered = false;
    let releaseAccounting!: () => void;
    const accountingGate = new Promise<void>((resolve) => { releaseAccounting = resolve; });
    const ex = new OffloadExecutor({
      state: s.state,
      accountId: "volatile-journal-inflight-test",
      poolId: "volatile-journal-inflight-pool",
      boat: s.boat as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: s.clock.now,
      timers: { set: s.clock.set, clear: s.clock.clear },
      config: { maxOffloadVms: 2, offloadIdleStopSeconds: 3600 },
      runCommand: async (_sandboxId: string, cmd) => {
        runs.push(cmd.commandId);
        return { exitCode: 0, seconds: 1 };
      },
      recordDuration: async (cmd) => {
        if (cmd.commandId === "gated") { accountingEntered = true; await accountingGate; }
      },
    });
    const gatedPending = ex.execute(command("gated", { executionWorkspaceId: "workspace-gated" }));
    await until(() => accountingEntered);
    // Fill the journal past its 512-entry cap while the gated command is
    // still settling, so other commands' cap eviction runs against it.
    for (let n = 0; n < 512; n += 1) {
      await ex.execute(command(`short-${n}`, { executionWorkspaceId: "workspace-shorts" }));
    }
    // The shorts' eviction ran while the gated command was still settling:
    // the duplicate must join the settled receipt, not start a second
    // execution. Raced so a regression fails fast: a re-executed duplicate
    // parks behind the same accounting gate instead of resolving.
    const dupPending = ex.execute(command("gated", { executionWorkspaceId: "workspace-gated" }));
    try {
      const joined = await Promise.race([
        dupPending,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("duplicate did not join the settled receipt")), 10_000)),
      ]);
      expect(joined).toMatchObject({ status: "completed" });
      expect(runs.filter((id) => id === "gated")).toHaveLength(1);
    } finally {
      releaseAccounting();
    }
    await expect(gatedPending).resolves.toMatchObject({ status: "completed" });
    await ex.shutdown();
  }, 180_000);

  it("an observed provider stop releases its watchdog paths for warm reuse", async () => {
    // The direct stop response and retirement both release the sandbox's
    // watchdog paths; an asynchronously observed stop must too, or every
    // stop-observe-resume cycle pins another dead path until retirement.
    s.boat.stopMode = "never";
    await s.execute(command("observed-paths"));
    const maps = executorMaps(s.executor);
    expect(maps.lifecycle?.watchdogPaths.size ?? 0).toBeGreaterThan(0);
    await s.clock.advance(15_000);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archiving");
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    await s.api().sweep?.();
    expect(maps.lifecycle?.watchdogPaths.size ?? -1).toBe(0);
  });
});

const PARENT = "/delegated-test-parent";
const LEAF = "paperclip-boat-0123456789abcdef0123456789abcdef";

function testIdentity(now: number): ExecutionIdentity {
  return { companyId: "company-a", runId: "run-a", commandId: "poll", digest: "abc",
    sandboxId: "vm-1", guestBootId: "boot-a", processGroupId: 4100,
    cgroupPath: `${PARENT}/${LEAF}`, journalGeneration: 1,
    heartbeatDeadline: now + 30_000, guestDeadline: now + 120_000 };
}

function guestWithFakeSsh(onRead: () => { events: unknown[]; result: { exitCode: number; seconds: number } | null },
  now: () => number, sleep: (ms: number) => Promise<void>, calls: string[]) {
  const page = (body: unknown) => ({ exitCode: 0 as const, signal: null, timedOut: false,
    stdout: JSON.stringify(body), stderr: "" });
  return new SshOffloadGuest({
    ssh: { runStream: async (_session: unknown, _remoteCommand: string) => {
      // runCommand always opens with exactly one start RPC; the rest are reads.
      const isStart = calls.length === 0;
      calls.push(isStart ? "start" : "read");
      if (isStart) return page({});
      const { events, result } = onRead();
      return page({ events, result, supervisorAlive: true, outputLimitExceeded: false });
    } } as never,
    session: async () => ({ sandboxId: "vm-1" }) as never,
    cgroupParent: PARENT,
    workspace: async () => "/tmp/offload-poll-test",
    sleep,
    now,
  });
}

describe("output poll backoff", () => {
  it("a quiet 10 s guest costs at most about 15 runStream calls", async () => {
    let t = 1_000_000;
    const started = t;
    const calls: string[] = [];
    const guest = guestWithFakeSsh(() => (t - started >= 10_000
      ? { events: [], result: { exitCode: 0, seconds: 10 } }
      : { events: [], result: null }), () => t, async (ms) => { t += ms; }, calls);
    const result = await guest.runCommand("vm-1",
      { commandId: "poll", companyId: "c", runId: "r", argv: ["test"] } as never,
      { identity: testIdentity(started), output: async () => {} });
    expect(result).toMatchObject({ exitCode: 0 });
    // One start plus exponentially backed-off reads (100 ms doubling to 1 s).
    expect(calls.length).toBeLessThanOrEqual(15);
    await guest.shutdown();
  });

  it("a 1,000-line stream arrives in a handful of bounded pages", async () => {
    let t = 2_000_000;
    const started = t;
    const calls: string[] = [];
    let next = 0;
    const received: string[] = [];
    const guest = guestWithFakeSsh(() => {
      const events = [];
      while (events.length < 64 && next < 1000) {
        events.push({ stream: "stdout", dataBase64: Buffer.from(`line-${next}\n`).toString("base64") });
        next += 1;
      }
      return { events, result: next >= 1000 ? { exitCode: 0, seconds: 1 } : null };
    }, () => t, async (ms) => { t += ms; }, calls);
    const result = await guest.runCommand("vm-1",
      { commandId: "stream", companyId: "c", runId: "r", argv: ["test"] } as never,
      { identity: testIdentity(started),
        output: async (_stream, bytes) => { received.push(Buffer.from(bytes).toString()); } });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(received).toHaveLength(1000);
    expect(received[999]).toBe("line-999\n");
    // 16 bounded pages plus start: far below one RPC per line.
    expect(calls.length).toBeLessThanOrEqual(32);
    await guest.shutdown();
  });
});

describe("output overflow fails closed", () => {
  function guestWithFailingReads(failure: () => unknown, now: () => number) {
    const page = (body: unknown) => ({ exitCode: 0 as const, signal: null, timedOut: false,
      stdout: JSON.stringify(body), stderr: "" });
    let calls = 0;
    return new SshOffloadGuest({
      ssh: { runStream: async () => {
        calls += 1;
        if (calls === 1) return page({});
        throw failure();
      } } as never,
      session: async () => ({ sandboxId: "vm-1" }) as never,
      cgroupParent: PARENT,
      workspace: async () => "/tmp/offload-poll-test",
      now,
    });
  }

  const run = (guest: SshOffloadGuest, t: number) => guest.runCommand("vm-1",
    { commandId: "overflow", companyId: "c", runId: "r", argv: ["test"] } as never,
    { identity: testIdentity(t), output: async () => {} });

  it("a read page that outgrows the RPC envelope rejects with OFFLOAD_OUTPUT_LIMIT", async () => {
    // A nonconforming page (or a budget bug) trips the control RPC's own byte
    // cap instead of parsing: the host must still fail closed with the
    // overflow code, never a generic transport error.
    const t = 3_000_000;
    const guest = guestWithFailingReads(() => Object.assign(
      new Error("Streaming process control output exceeds its byte limit."),
      { code: "SSH_CONTROL_OUTPUT_LIMIT" }), () => t);
    await expect(run(guest, t)).rejects.toMatchObject({ code: "OFFLOAD_OUTPUT_LIMIT" });
    await guest.shutdown();
  });

  it("other read failures keep their own code", async () => {
    const t = 4_000_000;
    const guest = guestWithFailingReads(
      () => Object.assign(new Error("boom"), { code: "OFFLOAD_GUEST_TRANSPORT_UNKNOWN" }), () => t);
    await expect(run(guest, t)).rejects.toMatchObject({ code: "OFFLOAD_GUEST_TRANSPORT_UNKNOWN" });
    await guest.shutdown();
  });

  it("guest read pages fit inside the control RPC envelope", () => {
    const events = Number(OFFLOAD_SSH_SCRIPT.match(/READ_PAGE_MAX_EVENTS = (\d+)/)?.[1]);
    const budget = Number(OFFLOAD_SSH_SCRIPT.match(/READ_PAGE_MAX_ENCODED_BYTES = (\d+)/)?.[1]);
    expect(events).toBeLessThanOrEqual(64);
    expect(budget).toBeGreaterThan(0);
    // One maximum-size event overshoot (an 8 KiB chunk is ~11 KiB of base64
    // JSON) plus envelope framing must still fit the 128 KiB transport cap, or
    // overflow surfaces as a generic transport error instead of
    // OFFLOAD_OUTPUT_LIMIT.
    expect(budget + 16 * 1024).toBeLessThanOrEqual(128 * 1024);
  });
});
