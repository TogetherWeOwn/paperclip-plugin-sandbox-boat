import { afterEach, describe, expect, it, vi } from "vitest";
import { OffloadLifecycle, type GuestController, type GuestIdentity } from "./offload-lifecycle.js";
import { commandDigest, commandKey, OffloadJournal, validGuestIdentity,
  type OffloadIdentity, type OffloadRecord } from "./offload-journal.js";
import { Clock, command, deferred, EPOCH, fixture, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";

function lifecycleHarness() {
  const clock = new Clock();
  const cmd = command("review");
  const base: OffloadIdentity = { companyId: cmd.companyId, runId: cmd.runId, commandId: cmd.commandId,
    digest: commandDigest(cmd), sandboxId: "review-vm", guestBootId: "boot-a", journalGeneration: 1 };
  const identity: GuestIdentity = { guestBootId: "boot-a", processGroupId: 4100,
    cgroupPath: "/delegated/review", journalGeneration: 1,
    heartbeatDeadline: clock.t + 30_000, guestDeadline: clock.t + 120_000 };
  const guest = {
    preflight: vi.fn(async () => ({ cgroupV2Delegated: true, outsideWatchdogVerified: true })),
    prepare: vi.fn(async () => structuredClone(identity)),
    armDeadline: vi.fn(async () => ({ verified: true, outsideCommandCgroup: true })),
    inspect: vi.fn(async (_vm: string, id: GuestIdentity) => ({ identity: id, receipt: "completed", populated: false })),
    term: vi.fn(async () => {}), kill: vi.fn(async () => {}), verifyEmpty: vi.fn(async () => true),
  } satisfies GuestController;
  const lifecycle = new OffloadLifecycle(guest, clock.now, { set: clock.set, clear: clock.clear });
  const transport = vi.fn(async () => ({ exitCode: 0, seconds: 1 }));
  return { clock, cmd, base, identity, guest, lifecycle, transport };
}

describe("review: guest boundary and asynchronous admission", () => {
  it.each(["//", "///", "/delegated//review", "/delegated/review/"])("rejects noncanonical cgroup path %s", (path) => {
    const { identity } = lifecycleHarness();
    expect(validGuestIdentity({ ...identity, cgroupPath: path })).toBe(false);
  });

  it.each([
    ["another boot", { guestBootId: "boot-b" }],
    ["another journal generation", { journalGeneration: 2 }],
    ["past heartbeat deadline", { heartbeatDeadline: EPOCH - 1 }],
    ["heartbeat deadline at now", { heartbeatDeadline: EPOCH }],
    ["heartbeat deadline beyond interest window", { heartbeatDeadline: EPOCH + 30_001 }],
    ["past guest deadline", { guestDeadline: EPOCH - 1 }],
    ["guest deadline at now", { guestDeadline: EPOCH }],
    ["guest deadline beyond command timeout", { guestDeadline: EPOCH + 120_001 }],
  ] satisfies Array<[string, Partial<GuestIdentity>]>)("rejects prepared identity with %s before spawning", async (_label, patch) => {
    const s = lifecycleHarness();
    s.guest.prepare.mockResolvedValue({ ...s.identity, ...patch });
    const execution = s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base)
      .then((identity) => s.lifecycle.run(identity, s.cmd, s.transport, async () => {}));
    await expect(execution).rejects.toMatchObject({ code: "OFFLOAD_GUEST_IDENTITY_INVALID" });
    expect(s.guest.armDeadline).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
  });

  it("rejects an unverified prepared boot even when it matches the host binding", async () => {
    const s = lifecycleHarness();
    s.base.guestBootId = "unverified:boot-a";
    s.guest.prepare.mockResolvedValue({ ...s.identity, guestBootId: s.base.guestBootId });
    const execution = s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base)
      .then((identity) => s.lifecycle.run(identity, s.cmd, s.transport, async () => {}));
    await expect(execution).rejects.toMatchObject({ code: "OFFLOAD_GUEST_IDENTITY_INVALID" });
    expect(s.guest.armDeadline).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
  });

  it.each([undefined, 10_000])("bounds the prepared guest deadline with timeoutMs=%s", async (timeoutMs) => {
    const s = lifecycleHarness();
    s.cmd.timeoutMs = timeoutMs;
    s.guest.prepare.mockResolvedValue({ ...s.identity, guestDeadline: EPOCH + (timeoutMs ?? 120_000) + 1 });
    const execution = s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base)
      .then((identity) => s.lifecycle.run(identity, s.cmd, s.transport, async () => {}));
    await expect(execution).rejects.toMatchObject({ code: "OFFLOAD_GUEST_IDENTITY_INVALID" });
    expect(s.guest.armDeadline).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
  });

  it("does not let guest-supplied extra fields replace host command bindings", async () => {
    const s = lifecycleHarness();
    s.guest.prepare.mockResolvedValue({ ...s.identity, sandboxId: "other-vm", companyId: "other-company",
      commandId: "other-command", digest: "other-digest" } as GuestIdentity);
    expect(await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base)).toEqual({ ...s.base, ...s.identity });
  });

  it.each([30_000, 120_000])("does not invoke transport when watchdog arming takes %s ms", async (delay) => {
    const s = lifecycleHarness();
    const armed = deferred<void>();
    s.guest.armDeadline.mockImplementation(async () => {
      await armed.promise;
      return { verified: true, outsideCommandCgroup: true };
    });
    const identity = await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base);
    const pending = s.lifecycle.run(identity, s.cmd, s.transport, async () => {});
    await s.clock.advance(delay);
    armed.resolve();
    const result = await pending;
    expect(s.transport).not.toHaveBeenCalled();
    expect(result).toMatchObject(delay === 120_000 ? { timedOut: true, exitCode: 124 } : { cancelled: true, exitCode: 130 });
  });

  it("retains cancellation between preparing the durable identity and invoking the lifecycle", async () => {
    const s = lifecycleHarness();
    s.guest.inspect.mockImplementation(async (_vm, identity) => ({ identity, receipt: "never_started", populated: false }));
    const identity = await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base);
    await s.lifecycle.cancel(identity, "client_signal");
    const result = await s.lifecycle.run(identity, s.cmd, s.transport, async () => {});
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.guest.term).not.toHaveBeenCalled();
    expect(s.guest.verifyEmpty).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ cancelled: true, exitCode: 130 });
  });

  it("cleans the subtree on transport rejection and removes worker deadline callbacks", async () => {
    const s = lifecycleHarness();
    let populated = true;
    s.guest.inspect.mockImplementation(async (_vm, identity) => ({ identity, receipt: "running", populated }));
    s.guest.kill.mockImplementation(async () => { populated = false; });
    s.transport.mockRejectedValue(new Error("lost transport"));
    const identity = await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base);
    const pending = s.lifecycle.run(identity, s.cmd, s.transport, async () => {}).catch((error: unknown) => error);
    await s.clock.advance(5_000);
    expect(await pending).toMatchObject({ message: "lost transport" });
    expect(populated).toBe(false);
    expect(s.guest.verifyEmpty).toHaveBeenCalledOnce();
    expect([...s.clock.timers.values()].filter((timer) => timer.owner === "worker")).toEqual([]);
  });

  it("does not reuse a watchdog path just because its nominal deadline elapsed", async () => {
    const s = lifecycleHarness();
    const identity = await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base);
    await s.lifecycle.run(identity, s.cmd, s.transport, async () => {});
    // A guest watchdog can already be queued/delayed; time alone does not
    // attest that it ran or was revoked. A new command must use a fresh path.
    await s.clock.advance(120_000);
    const next = command("next");
    s.guest.prepare.mockResolvedValue({ ...s.identity, heartbeatDeadline: s.clock.t + 30_000, guestDeadline: s.clock.t + 120_000 });
    await expect(s.lifecycle.prepare(s.base.sandboxId, next,
      { ...s.base, commandId: next.commandId, digest: commandDigest(next) })).rejects.toMatchObject({ code: "OFFLOAD_GUEST_CGROUP_REUSED" });
  });

  it("does not leave an active entry after watchdog arm failure", async () => {
    const s = lifecycleHarness();
    s.guest.armDeadline.mockRejectedValue(new Error("arm failed"));
    const identity = await s.lifecycle.prepare(s.base.sandboxId, s.cmd, s.base);
    await expect(s.lifecycle.run(identity, s.cmd, s.transport, async () => {})).rejects.toThrow("arm failed");
    await s.lifecycle.cancel(identity, "client_signal");
    expect(s.guest.inspect).not.toHaveBeenCalled();
  });
});

// These are separate review regressions, not edits to the independent acceptance suite.
let f: Fixture | undefined;
afterEach(async () => { await f?.dispose(); f = undefined; });

describe("review: durable lifecycle result safety", () => {
  it("quarantines instead of releasing a failed cleanup on a leader-only result receipt", async () => {
    f = await fixture();
    const s = f;
    const cmd = command("failed-cleanup");
    s.descendants();
    s.guest.failKill = true;
    const pending = s.execute(cmd);
    await until(() => s.starts.length === 1);
    await s.clock.advance(5_000);
    expect(await pending).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(s.guest.alive(cmd.commandId)).toBe(true);
    const stored = await s.state.store().get(commandKey(cmd)) as OffloadRecord;
    const store = s.state.store();
    // Reopen the actual persisted command through a fresh journal, with the
    // same leader-result proof an adapter could write before descendant cleanup.
    const release = vi.fn(async () => {});
    const journal = new OffloadJournal({ journalStore: store,
      guestReceipts: { read: async () => ({ version: 1, kind: "result", identity: stored.identity,
        result: { exitCode: 0, seconds: 1 } }) },
      resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: s.clock.t + 86_400_000 }),
      sync: { push: async () => {}, collect: async () => {}, stage: async () => {} },
    }, s.clock.now, { hold: async () => {}, release, cancel: async () => {} },
    new OffloadLifecycle(s.guest, s.clock.now, { set: s.clock.set, clear: s.clock.clear }));
    const launch = vi.fn(async () => { throw new Error("must not relaunch"); });
    expect(await journal.execute(cmd, launch)).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(release).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects an empty cancellation reason without killing work or disabling its heartbeat", async () => {
    f = await fixture();
    const s = f;
    const gate = s.hold("exec:active");
    const pending = s.execute(command("active"));
    await until(() => s.trace.includes("exec:active"));
    // Catch immediately so the baseline's five-second cancellation cleanup
    // cannot strand teardown when the expected validation is absent.
    const cancellation = s.executor.cancel("active", "", 1).catch((error: unknown) => error);
    await s.clock.advance(5_000);
    expect(await cancellation).toMatchObject({ code: "OFFLOAD_INVALID_REQUEST" });
    expect(s.guest.actions.filter((action) => action.kind === "term")).toEqual([]);
    gate.resolve();
    await pending;
  });

  it("bounds event metadata even when a guest emits tiny output chunks", async () => {
    f = await fixture();
    const s = f;
    const cmd = command("fragmented-output");
    const prepare = s.guest.prepare;
    s.guest.prepare = async (vm, command) => {
      // Model a retained prefix of 16,384 one-byte writes without performing
      // quadratic disk I/O in the test. It is valid journal evidence, not a
      // competing output or admission implementation.
      const store = s.state.store();
      const record = await store.get(commandKey(cmd)) as OffloadRecord;
      await store.set(commandKey(cmd), { ...record, output: Array.from({ length: 16_384 }, (_, index) =>
        ({ seq: index + 1, stream: "stdout", dataBase64: "eA==" })) });
      return await prepare(vm, command);
    };
    s.output([["stderr", new Uint8Array([255])]]);
    const pending = s.execute(cmd);
    await until(() => s.starts.length === 1);
    await s.clock.advance(5_000);
    expect(await pending).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(s.guest.alive(cmd.commandId)).toBe(false);
    const record = await s.state.store().get(commandKey(cmd)) as OffloadRecord;
    expect(record.output).toHaveLength(16_384);
  });

  it.each(["single-write", "cumulative"])("bounds %s output rather than letting one guest exhaust the journal", async (mode) => {
    f = await fixture();
    const s = f;
    s.output(mode === "single-write" ? [["stdout", new Uint8Array(1_048_577).fill(255)]]
      : [["stdout", new Uint8Array(1_048_576).fill(255)], ["stderr", new Uint8Array([255])]]);
    const pending = s.execute(command("output-flood"));
    await until(() => s.starts.length === 1);
    await s.clock.advance(5_000);
    const result = await pending;
    expect(result).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(s.guest.alive("output-flood")).toBe(false);
    const record = await s.state.store().get(commandKey(command("output-flood"))) as OffloadRecord;
    const retained = (record.output ?? []).reduce((total, event) => total + Buffer.from(event.dataBase64, "base64").length, 0);
    expect(retained).toBe(mode === "cumulative" ? 1_048_576 : 0);
  });
});
