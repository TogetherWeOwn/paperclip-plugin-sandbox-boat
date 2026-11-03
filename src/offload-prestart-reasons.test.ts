import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OffloadJournal, offloadError, type OffloadSync } from "./offload-journal.js";
import { command as lifecycleCommand, DiskState, EPOCH, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";

// A command that fails before transport is a known non-start, but which
// pre-start step failed (sync push, guest boot identity, lifecycle prepare,
// the starting-intent commit, pool bind) is the operator-actionable signal.
// These tests pin that each site yields its own named, sanitized reason in
// the journal result and the not_started view the shim announces, and that
// the executor logs the site with command and sandbox identity.

const DAY = 86_400_000;

describe("journal names the failed pre-start step", () => {
  let dir: string;
  let state: DiskState;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "prestart-journal-"));
    state = new DiskState(path.join(dir, "state.json"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function makeJournal(options: {
    sync?: Partial<OffloadSync>;
    bootId?: () => Promise<string>;
    prepare?: () => Promise<never>;
    lifecycle?: boolean;
    bind?: () => Promise<void>;
    failCommitState?: string;
  } = {}) {
    const discard = vi.fn(async () => {});
    const lifecycleDiscard = vi.fn(() => {});
    const transport = vi.fn(async () => ({ exitCode: 0, seconds: 1 }));
    const baseStore = state.store();
    const journalStore = options.failCommitState
      ? { ...baseStore, set: async (key: string, value: unknown) => {
          if ((value as { state?: string } | null)?.state === options.failCommitState) {
            throw Object.assign(new Error("store io"), { code: "EIO" });
          }
          return baseStore.set(key, value);
        } }
      : baseStore;
    const lifecycle = options.prepare
      ? { prepare: options.prepare, discard: lifecycleDiscard, cancel: async () => {}, heartbeat: () => {} }
      : options.lifecycle
        ? { prepare: async (_vm: string, _cmd: unknown, base: unknown) => base as never,
            discard: lifecycleDiscard, cancel: async () => {}, heartbeat: () => {} }
        : undefined;
    const journal = new OffloadJournal({ journalStore,
      guestReceipts: { bootId: options.bootId ?? (async () => "boot-a"), read: async () => null },
      resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + DAY }),
      sync: { push: async () => {}, collect: async () => ({}), stage: async () => undefined, markSuspect: async () => {}, discard, ...options.sync },
    }, () => EPOCH, { hold: async () => {}, release: async () => {}, cancel: async () => {},
      ...(options.bind ? { bind: options.bind } : {}) }, lifecycle);
    return { journal, discard, lifecycleDiscard, transport };
  }

  // Mirrors OffloadExecutor.runOnVm: a thrown pre-start failure becomes an
  // `unknown` carrying the journal-recorded reason, which finish() converts.
  async function attempt(journal: OffloadJournal, cmd: ReturnType<typeof lifecycleCommand>,
    transport: () => Promise<{ exitCode: number; seconds: number }> = async () => ({ exitCode: 0, seconds: 1 }),
    callerReason = false) {
    return journal.execute(cmd, async () => {
      try {
        const raw = await journal.run("vm", cmd, transport);
        return await journal.finish(cmd, { status: "completed", commandId: cmd.commandId,
          sandboxId: "vm", warm: "cold", queueWaitMs: 0, dollars: 0, ...raw });
      } catch {
        return await journal.finish(cmd, { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: cmd.commandId, sandboxId: "vm",
          warm: "cold", queueWaitMs: 0, remoteStarted: true, fallbackSafe: false, exitCode: 75, seconds: 0, dollars: 0,
          reason: callerReason ? "caller supplied" : journal.preStartFailure(cmd)?.reason ?? "test" });
      }
    });
  }

  it("sync push failure names the step and never leaks the raw message", async () => {
    const secret = "guest bytes /home/agent/.ssh/id_ed25519 BEGIN PRIVATE KEY";
    const { journal } = makeJournal({ sync: { push: async () => { throw new Error(secret); } } });
    const cmd = lifecycleCommand("prestart-push");
    const result = await attempt(journal, cmd);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "sync push failed before the command could start" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await journal.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({
      state: "not_started", fallbackReason: "sync push failed before the command could start" });
  });

  it("boot identity failure names its step and code even when the caller passes a generic reason", async () => {
    const { journal, discard, transport } = makeJournal({ bootId: async () => { throw offloadError("OFFLOAD_GUEST_TRANSPORT_UNKNOWN"); } });
    const cmd = lifecycleCommand("prestart-boot");
    const result = await attempt(journal, cmd, transport, true);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "guest boot identity failed before the command could start (OFFLOAD_GUEST_TRANSPORT_UNKNOWN)" });
    expect(discard).toHaveBeenCalledWith("vm", cmd);
  });

  it("lifecycle prepare failure names its step and code", async () => {
    const { journal, discard } = makeJournal({ prepare: async () => { throw offloadError("OFFLOAD_GUEST_INELIGIBLE"); } });
    const cmd = lifecycleCommand("prestart-prepare");
    const result = await attempt(journal, cmd);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "guest lifecycle prepare failed before the command could start (OFFLOAD_GUEST_INELIGIBLE)" });
    expect(discard).toHaveBeenCalledWith("vm", cmd);
  });

  it("starting-intent commit failure names its step and errno code", async () => {
    const { journal, transport, lifecycleDiscard } = makeJournal({ failCommitState: "starting", lifecycle: true });
    const cmd = lifecycleCommand("prestart-commit");
    const result = await attempt(journal, cmd, transport);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "durable starting intent commit failed before the command could start (EIO)" });
    expect(transport).not.toHaveBeenCalled();
    expect(lifecycleDiscard).toHaveBeenCalledOnce();
    expect(await journal.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({ state: "not_started" });
  });

  it("pool bind failure after the starting commit stays unknown but names its step", async () => {
    const { journal, transport, lifecycleDiscard } = makeJournal({ lifecycle: true,
      bind: async () => { throw offloadError("OFFLOAD_POOL_OWNERSHIP_UNKNOWN"); } });
    const cmd = lifecycleCommand("prestart-bind");
    const result = await attempt(journal, cmd, transport);
    // The starting intent is durable, so this is never a fallback receipt —
    // but the unknown still says which site failed instead of a generic
    // transport failure.
    expect(result).toMatchObject({ status: "unknown", fallbackSafe: false,
      reason: "pool identity bind failed before the command could start (OFFLOAD_POOL_OWNERSHIP_UNKNOWN)" });
    expect(transport).not.toHaveBeenCalled();
    expect(lifecycleDiscard).toHaveBeenCalledOnce();
    expect(await journal.readCommand(cmd.companyId, cmd.runId, cmd.commandId)).toMatchObject({
      state: "unknown", remoteStarted: null, fallbackSafe: false });
  });

  it("sync-in commit failure names its step", async () => {
    const { journal, transport } = makeJournal({ failCommitState: "syncing_in" });
    const cmd = lifecycleCommand("prestart-syncin");
    const result = await attempt(journal, cmd, transport);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "sync-in journal commit failed before the command could start (EIO)" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("cancellation during push settles with the dedicated cancellation reason", async () => {
    let release!: () => void;
    const pushing = new Promise<void>((resolve) => { release = resolve; });
    let pushed!: () => void;
    const started = new Promise<void>((resolve) => { pushed = resolve; });
    const { journal, transport } = makeJournal({ lifecycle: true,
      sync: { push: async () => { pushed(); await pushing; } } });
    const cmd = lifecycleCommand("prestart-cancel");
    const result = attempt(journal, cmd, transport);
    await started;
    await journal.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
    release();
    expect(await result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "cancelled before durable starting intent" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("an adversarial adapter error cannot inject a reason, a message, or a throw", async () => {
    // Frozen, carries a forged failure record and a code-shaped raw message.
    const forged = Object.freeze(Object.assign(new Error("CUSTOMER_RECORD_1234"), {
      preStartFailure: { step: "sync push", code: null, reason: "leaked /home/agent/secret" },
    }));
    const accessor = new Error("accessor");
    Object.defineProperty(accessor, "code", { get() { throw new Error("getter boom"); } });
    for (const [name, error] of [["forged", forged], ["accessor", accessor]] as const) {
      const { journal } = makeJournal({ sync: { push: async () => { throw error; } } });
      const cmd = lifecycleCommand(`prestart-${name}`);
      const result = await attempt(journal, cmd);
      expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
        reason: "sync push failed before the command could start" });
      expect(JSON.stringify(result)).not.toContain("CUSTOMER_RECORD_1234");
      expect(JSON.stringify(result)).not.toContain("leaked");
    }
  });
});

describe("executor logs and releases on a pre-start failure", () => {
  let s: Fixture;
  beforeEach(async () => { s = await fixture(); });
  afterEach(async () => { await s.dispose(); });

  it("sync push failure: named reason end to end, warn with command/sandbox identity, VM released for reuse", async () => {
    const cmd = lifecycleCommand("exec-push-fail");
    s.fail.add(`push:${cmd.commandId}`);
    const result = await s.execute(cmd);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "sync push failed before the command could start" });
    // The injected adapter message must not leak into the journaled reason.
    expect(JSON.stringify(result)).not.toContain("injected push failure");
    const warn = s.logs.find((entry) => entry.message === "boat offload command failed before starting intent");
    expect(warn?.meta).toMatchObject({ commandId: cmd.commandId, step: "sync push", code: null,
      reason: "sync push failed before the command could start" });
    expect(typeof warn?.meta?.sandboxId).toBe("string");
    expect((warn?.meta?.sandboxId as string).length).toBeGreaterThan(0);
    expect(s.logs.some((entry) => entry.message.includes("quarantined"))).toBe(false);
    // The read view carries the same reason the shim announces.
    expect(await s.executor.read(cmd.commandId)).toMatchObject({ state: "not_started",
      fallbackReason: "sync push failed before the command could start" });
    // Released, not quarantined: the next command reuses the same VM.
    const second = await s.execute(lifecycleCommand("exec-after-fail"));
    expect(second).toMatchObject({ status: "completed" });
    expect(s.starts).toHaveLength(1);
    expect(s.starts[0]?.sandboxId).toBe(warn?.meta?.sandboxId);
  });

  it("guest ineligible at lifecycle prepare: named step and code in result and log", async () => {
    s.guest.delegated = false;
    const cmd = lifecycleCommand("exec-prepare-fail");
    const result = await s.execute(cmd);
    expect(result).toMatchObject({ status: "unavailable", remoteStarted: false, fallbackSafe: true,
      reason: "guest lifecycle prepare failed before the command could start (OFFLOAD_GUEST_INELIGIBLE)" });
    const warn = s.logs.find((entry) => entry.message === "boat offload command failed before starting intent");
    expect(warn?.meta).toMatchObject({ commandId: cmd.commandId, step: "guest lifecycle prepare",
      code: "OFFLOAD_GUEST_INELIGIBLE" });
    expect(s.starts).toEqual([]);
  });
});
