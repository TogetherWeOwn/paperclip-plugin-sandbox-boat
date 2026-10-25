import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, EPOCH, fixture, until } from "./test-support/offload-lifecycle-contract.js";
import type { Fixture } from "./test-support/offload-lifecycle-contract.js";
import { commandKey, matchingReceipt, type OffloadRecord } from "./offload-journal.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

describe("guest lifecycle boundary regressions", () => {
  it("does not kill a replacement identity after the TERM grace interval", async () => {
    const gate = s.hold("exec:replaced");
    const pending = s.execute(command("replaced"));
    await until(() => s.trace.includes("exec:replaced"));
    const cancel = s.executor.cancel("replaced", "client_signal", 1).catch(() => undefined);
    await s.clock.advance(4_999);
    s.guest.trees.get("replaced")!.identity.guestBootId = "replacement-boot";
    await s.clock.advance(1);
    await cancel;
    expect(s.guest.actions.filter((v) => v.kind === "kill")).toEqual([]);
    gate.resolve();
    expect(await pending).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(await s.execute(command("probe"))).toMatchObject({ status: "unavailable" });
  });

  it("stale heartbeats and cancel requests cannot affect a current generation", async () => {
    s.hold("exec:active");
    const pending = s.execute(command("active"));
    await until(() => s.trace.includes("exec:active"));
    await s.clock.advance(25_000);
    await s.executor.heartbeat("active", 2);
    await s.executor.cancel("active", "client_signal", 2);
    expect(s.guest.actions.filter((v) => v.kind === "term")).toEqual([]);
    await s.clock.advance(5_000);
    expect(s.guest.actions.filter((v) => v.kind === "term")).toHaveLength(1);
    await s.clock.advance(5_000);
    expect(await pending).toMatchObject({ remoteStarted: true, fallbackSafe: false, cancelled: true });
  });

  it("reports a timeout rather than success even when the transport resolves with zero", async () => {
    s.hold("exec:deadline");
    const pending = s.execute(command("deadline", { timeoutMs: 10_000 }));
    await until(() => s.trace.includes("exec:deadline"));
    await s.clock.advance(10_000);
    expect(await pending).toMatchObject({ exitCode: 124, timedOut: true, fallbackSafe: false });
    expect(await s.executor.read("deadline")).toMatchObject({ result: { timedOut: true, exitCode: 124 } });
  });

  it.each([
    { verified: true, outsideCommandCgroup: false },
    { verified: false, outsideCommandCgroup: true },
    { verified: false, outsideCommandCgroup: false },
  ])("never invokes transport without positive outside-watchdog arm evidence: %j", async (armed) => {
    s.guest.armDeadline = async () => armed;
    const result = await s.execute(command("unarmed"));
    expect(result).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(s.starts).toEqual([]);
    expect(await s.execute(command("probe"))).toMatchObject({ status: "unavailable" });
  });

  it("cannot return an expired result through start instead of execute", async () => {
    await s.execute(command("expired"));
    await s.clock.advance(86_400_000);
    await expect(s.executor.start(command("expired"))).rejects.toMatchObject({ code: "OFFLOAD_RESULT_EXPIRED" });
    expect(s.starts).toHaveLength(1);
  });

  it("never reuses a cgroup path while its previous absolute watchdog is armed", async () => {
    await s.execute(command("first"));
    const prepare = s.guest.prepare;
    s.guest.prepare = async (vm, cmd) => ({ ...await prepare(vm, cmd), cgroupPath: "/delegated/commands/first" });
    const next = await s.execute(command("second"));
    expect(next).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.starts.map((v) => v.commandId)).toEqual(["first"]);
  });

  it("matches guest receipts across renewed interest but not changed subtree ownership", async () => {
    await s.execute(command("receipt"));
    const identity = s.starts[0]!.context!.identity;
    // Mutable client-interest deadlines are not part of immutable ownership.
    const full = { companyId: "company-a", runId: "run-a", commandId: "receipt", digest: "abc",
      sandboxId: s.starts[0]!.sandboxId, ...identity };
    const receipt = { version: 1, kind: "result", identity: full, result: { exitCode: 0, seconds: 1 } };
    expect(matchingReceipt(receipt, { ...full, heartbeatDeadline: EPOCH + 60_000 })).toBe(true);
    expect(matchingReceipt(receipt, { ...full, cgroupPath: "/another" })).toBe(false);
  });
});

describe("start and output API regressions", () => {
  it.each(["output", "identity"])("fails closed on corrupt persisted %s", async (field) => {
    const cmd = command("corrupt");
    await s.execute(cmd);
    const store = s.state.store();
    const record = await store.get(commandKey(cmd)) as OffloadRecord;
    const patch = field === "output" ? { output: [{ seq: 1, stream: "stdout", dataBase64: 12 }] }
      : { identity: { ...record.identity, cgroupPath: "/" } };
    await store.set(commandKey(cmd), { ...record, ...patch });
    await expect(s.executor.read("corrupt")).rejects.toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
  });
  it("joins duplicate starts and byte-chunks a single oversized transport write", async () => {
    const gate = s.hold("exec:streaming");
    const data = new Uint8Array(70_000).fill(255);
    s.output([["stdout", data]]);
    const [first, second] = await Promise.all([s.executor.start(command("streaming")), s.executor.start(command("streaming"))]);
    expect(first).toEqual(second);
    await until(() => s.trace.includes("exec:streaming"));
    const page = await s.executor.read("streaming", 0, 1_000_000);
    const bytes = (events: typeof page.events) => Buffer.concat(events.map((v) => Buffer.from(v.dataBase64, "base64")));
    expect(bytes(page.events)).toHaveLength(65_536);
    const tail = await s.executor.read("streaming", page.nextCursor);
    expect(Buffer.concat([bytes(page.events), bytes(tail.events)])).toEqual(Buffer.alloc(70_000, 255));
    expect(s.starts).toHaveLength(1);
    await expect(s.executor.read("streaming", -1)).rejects.toMatchObject({ code: "OFFLOAD_INVALID_REQUEST" });
    gate.resolve();
    await s.execute(command("streaming"));
  });

  it("a read below the next event's size fails without advancing or losing bytes", async () => {
    s.output([["stderr", new Uint8Array(1024).fill(7)]]);
    await s.execute(command("small-read"));
    await expect(s.executor.read("small-read", 0, 1)).rejects.toMatchObject({ code: "OFFLOAD_OUTPUT_READ_TOO_SMALL" });
    const full = await s.executor.read("small-read");
    expect(full.nextCursor).toBe(1);
    expect(Buffer.from(full.events[0]!.dataBase64, "base64")).toEqual(Buffer.alloc(1024, 7));
  });

  it("ID-only convenience methods fail closed for ambiguous run-scoped IDs", async () => {
    await s.execute(command("same"));
    await s.execute(command("same", { runId: "run-b" }));
    await expect(s.executor.read("same")).rejects.toThrow("OFFLOAD_COMMAND_SCOPE_REQUIRED");
    expect(await s.executor.readCommand("company-a", "run-a", "same")).toMatchObject({ state: "completed" });
  });
});
