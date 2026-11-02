import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";
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
  private parsed(key: string) { return JSON.parse(key) as { namespace: string; stateKey: string }; }
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
