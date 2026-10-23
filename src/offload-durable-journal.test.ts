import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY, EPOCH, FileStore, cargoResult, command, digest, flush, harness, hostKey,
  identity, receipt, record, settled, wireResult,
  type Command, type Executor, type RecordV1, type State,
} from "./test-support/durable-offload.js";

// Acceptance-owned: test-only prerequisite, not a live backend. Every restart
// allocates a new executor AND a new filesystem store at the same disk path.
let root: string;
let h: ReturnType<typeof harness>;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "durable-offload-"));
  h = harness(root);
});
afterEach(async () => { h.crash(); await rm(root, { recursive: true, force: true }); });
async function seed(state: State, cmd = command(), patch: Partial<RecordV1> = {}) {
  const store = new FileStore(h.hostDirectory);
  await store.set(hostKey(cmd), { ...record(state, cmd), ...patch });
  if (["starting", "running", "syncing_out", "unknown"].includes(state)) {
    h.boat.addSandbox({ id: identity(cmd).sandboxId, state: "ready", noEnv: true });
  }
}
function method(executor: Executor, name: "recover" | "collectGarbage" | "readCommand" | "cancelCommand") {
  expect(typeof executor[name], `missing production surface: OffloadExecutor.${name}`).toBe("function");
}
async function view(executor: Executor, cmd = command()) {
  method(executor, "readCommand");
  return executor.readCommand(cmd.companyId, cmd.runId, cmd.commandId);
}
async function gc(executor: Executor) { method(executor, "collectGarbage"); await executor.collectGarbage(); }

// Catches write-after-dispatch and silently ignored persistence errors, using
// the existing execute() surface rather than a missing-module failure.
describe("durable host journal: effect fences", () => {
  it("persists every host state in order, with starting durable before transport", async () => {
    const { executor, store } = h.openExecutor();
    await executor.execute(command());
    const states = store.writes.filter((w) => w.key === hostKey(command()))
      .map((w) => (w.value as RecordV1).state);
    expect(states).toEqual(["accepted", "queued", "syncing_in", "starting", "running", "syncing_out", "completed"]);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0].intent).toMatchObject({ state: "starting", digest: digest(command()) });
    expect(h.attempts[0].identity).toMatchObject({
      companyId: "company-1", runId: "run-1", commandId: "command-1", digest: digest(command()),
    });
    const reopened = await new FileStore(h.hostDirectory).get(hostKey(command()));
    expect(reopened).toMatchObject({ state: "completed", result: { status: "completed", exitCode: 23 } });
  });

  it.each(["accepted", "queued", "syncing_in", "starting"] as State[])(
    "a failed %s commit prevents any guest dispatch", async (state) => {
      const store = new FileStore(h.hostDirectory);
      store.fail = (_key, value) => (value as RecordV1 | null)?.state === state;
      const { executor } = h.openExecutor({ journalStore: store });
      await settled(executor.execute(command()));
      expect(h.attempts, "persistence failure must fence transport").toHaveLength(0);
    },
  );

  it("does not advertise fallback when persisting a not_started refusal fails", async () => {
    h.boat.failNext("limits", new Error("limits unavailable"));
    const store = new FileStore(h.hostDirectory);
    store.fail = (_key, value) => (value as RecordV1 | null)?.state === "not_started";
    const { executor } = h.openExecutor({ journalStore: store });
    const result = await settled(executor.execute(command()));
    expect(result).not.toMatchObject({ fallbackSafe: true });
    expect(h.attempts).toHaveLength(0);
  });

  it("failed running commit leaves the existing intent held across restart", async () => {
    const store = new FileStore(h.hostDirectory);
    store.fail = (_key, value) => (value as RecordV1 | null)?.state === "running";
    await settled(h.openExecutor({ journalStore: store }).executor.execute(command()));
    const beforeRestart = h.attempts.length;
    h.crash();
    const replay = await settled(h.openExecutor().executor.execute(command()));
    expect(h.attempts, "loss of running acknowledgement must never grant another dispatch").toHaveLength(beforeRestart);
    expect(replay).not.toMatchObject({ fallbackSafe: true });
  });

  it.each(["syncing_out", "completed"] as State[])("host %s commit loss recovers a durable guest result without redispatch", async (state) => {
    const store = new FileStore(h.hostDirectory);
    store.fail = (_key, value) => (value as RecordV1 | null)?.state === state;
    const first = h.openExecutor({ journalStore: store });
    await settled(first.executor.execute(command()));
    h.crash();
    const persisted = await new FileStore(h.hostDirectory).get(hostKey(command())) as RecordV1 | null;
    expect(persisted?.identity, "starting identity must survive the result-commit failure").toBeTruthy();
    h.setReceipt(receipt("result", persisted!.identity!));
    const second = h.openExecutor();
    expect(await second.executor.execute(command())).toMatchObject({ status: "completed", exitCode: 23 });
    expect(h.attempts).toHaveLength(1);
  });
});

describe("durable host journal: run-scoped identity", () => {
  it("reopens a completed result after process-style restart without a second spawn", async () => {
    const first = h.openExecutor();
    const result = await first.executor.execute(command());
    h.crash();
    const second = h.openExecutor();
    expect(second.store).not.toBe(first.store);
    const replay = await second.executor.execute(command());
    expect(h.attempts, "a new executor must consult disk, not an empty in-memory Map").toHaveLength(1);
    expect(replay).toEqual(result);
  });

  it("joins eight concurrent identical requests, then joins again after restart", async () => {
    const first = h.openExecutor();
    const results = await Promise.all(Array.from({ length: 8 }, () => first.executor.execute(command())));
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(h.attempts).toHaveLength(1);
    h.crash();
    expect(await h.openExecutor().executor.execute(command())).toEqual(results[0]);
    expect(h.attempts).toHaveLength(1);
  });

  it("identical command IDs in distinct active runs are separate commands", async () => {
    const { executor } = h.openExecutor();
    const other = command("command-1", { runId: "run-2", cardId: "card-2", executionWorkspaceId: "workspace-2" });
    const first = await settled(executor.execute(command()));
    const second = await settled(executor.execute(other));
    expect(first).toMatchObject({ status: "completed" });
    expect(second).toMatchObject({ status: "completed" });
    expect(h.attempts.map((a) => a.command.runId)).toEqual(["run-1", "run-2"]);
    h.crash();
    const restarted = h.openExecutor().executor;
    expect(await restarted.execute(command())).toEqual(first);
    expect(await restarted.execute(other)).toEqual(second);
    expect(h.attempts).toHaveLength(2);
  });

  it.each([
    { argv: ["build", "--locked"] }, { env: { CARGO_TERM_COLOR: "always" } },
    { cwdRelative: "crate" }, { executionWorkspaceId: "workspace-2" },
    { timeoutMs: 60_000 }, { profileId: "other-profile" }, { repoId: "other-repo" },
  ] satisfies Partial<Command>[])("rejects changed payload after restart: %j", async (change) => {
    await h.openExecutor().executor.execute(command());
    h.crash();
    const result = await settled(h.openExecutor().executor.execute(command("command-1", change)));
    expect(result).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    expect(h.attempts).toHaveLength(1);
  });

  it("same logical environment in a different key order is not a new payload", async () => {
    const cmd = command("ordered", { env: { CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "1" } });
    const result = await h.openExecutor().executor.execute(cmd);
    h.crash();
    const reordered = command("ordered", { env: { RUST_BACKTRACE: "1", CARGO_TERM_COLOR: "never" } });
    expect(await h.openExecutor().executor.execute(reordered)).toEqual(result);
    expect(h.attempts).toHaveLength(1);
  });

  it.each([false, true])("512 retained IDs (tombstones=%s) refuse ID 513 across restart", async (tombstone) => {
    const store = new FileStore(h.hostDirectory);
    for (let i = 0; i < 512; i++) {
      const cmd = command(`retained-${i}`);
      await store.set(hostKey(cmd), {
        ...record("completed", cmd), tombstone,
        ...(tombstone ? { command: undefined, result: null } : {}),
      });
    }
    const { executor } = h.openExecutor();
    const result = await settled(executor.execute(command("overflow")));
    expect(result).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(h.attempts).toHaveLength(0);
    expect(await store.list("command/")).toHaveLength(512);
  }, 15_000);

  it("a replay at capacity consumes no slot and cannot evict another ID", async () => {
    const store = new FileStore(h.hostDirectory);
    for (let i = 0; i < 512; i++) await seed("completed", command(`retained-${i}`));
    const { executor } = h.openExecutor();
    expect(await executor.execute(command("retained-0"))).toMatchObject({ status: "completed", exitCode: 23 });
    expect(h.attempts).toHaveLength(0);
    expect(await store.list("command/")).toHaveLength(512);
    expect(await store.get(hostKey(command("retained-511")))).not.toBeNull();
  }, 15_000);

  it.each([true, false])("terminal-run rejection precedes journal lookup (cached=%s)", async (cached) => {
    if (cached) await seed("completed");
    h.runStates.set("run-1", { permanentlyTerminal: true, terminatedAt: EPOCH, tokenExpiresAt: EPOCH + DAY });
    const { executor, store } = h.openExecutor();
    const result = await settled(executor.execute(command()));
    expect(result).toMatchObject({ code: "OFFLOAD_FORBIDDEN" });
    expect(store.reads, "not even a cached success may be consulted").toEqual([]);
    expect(h.attempts).toHaveLength(0);
  });
});

describe("durable host journal: restart recovery matrix", () => {
  it.each(["accepted", "queued", "syncing_in"] as State[])(
    "persisted %s with no starting intent recovers never-started, not a fresh dispatch", async (state) => {
      await seed(state);
      const { executor } = h.openExecutor();
      const result = await settled(executor.execute(command()));
      expect(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
      expect(h.attempts).toHaveLength(0);
      expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "not_started" });
      h.crash();
      expect(await h.openExecutor().executor.execute(command())).toEqual(result);
      expect(h.attempts).toHaveLength(0);
    },
  );

  it.each(["missing", "marker", "started"])("starting intent plus %s receipt never proves nonexecution", async (kind) => {
    await seed("starting");
    h.setReceipt(kind === "missing" ? null : receipt(kind as "marker" | "started"));
    const { executor } = h.openExecutor();
    const result = await settled(executor.execute(command()));
    expect(h.attempts, "a persisted starting intent must not redispatch after restart").toHaveLength(0);
    expect(result).toMatchObject({ fallbackSafe: false });
    expect(result).not.toMatchObject({ status: "completed" });
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({
      state: kind === "started" ? "running" : "unknown",
    });
  });

  it("only a matching durable never-started fence can resolve a starting gap to safe fallback", async () => {
    await seed("starting");
    h.setReceipt(receipt("not_started"));
    const { executor } = h.openExecutor();
    const result = await settled(executor.execute(command()));
    expect(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(h.attempts).toHaveLength(0);
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "not_started" });
  });

  it.each(["running", "syncing_out", "unknown"] as State[])(
    "%s plus matching durable terminal result recovers the real Cargo exit without respawn", async (state) => {
      await seed(state);
      h.setReceipt(receipt("result"));
      const { executor } = h.openExecutor();
      expect(await executor.execute(command())).toMatchObject({ status: "completed", exitCode: 23 });
      expect(h.attempts).toHaveLength(0);
      expect(h.receiptReads).toEqual([identity()]);
      h.crash();
      expect(await h.openExecutor().executor.execute(command())).toMatchObject({ status: "completed", exitCode: 23 });
      expect(h.attempts).toHaveLength(0);
    },
  );

  it("a post-start transport error persists unknown and survives restart without local fallback", async () => {
    const { executor } = h.openExecutor({ runCommand: async () => { throw new Error("lost SSH reply after possible start"); } });
    const result = await settled(executor.execute(command()));
    expect(result).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "unknown" });
    h.crash();
    expect(await h.openExecutor().executor.execute(command())).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(h.attempts).toHaveLength(0);
  });
});

describe("durable host journal: quarantine and binding", () => {
  it("a different command cannot bypass a disk-only unknown reservation after restart", async () => {
    await seed("unknown");
    const { executor } = h.openExecutor();
    const next = await settled(executor.execute(command("next-after-crash")));
    expect(next).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(h.attempts, "startup reconciliation must restore reservations before admission").toHaveLength(0);
    await h.advance(60_000);
    await executor.shutdown();
    expect(h.boat.callsOf("stop")).toHaveLength(0);
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "unknown" });
  });

  it("matching terminal verification resolves the hold before a new command can use capacity", async () => {
    await seed("unknown"); h.setReceipt(receipt("result"));
    const { executor } = h.openExecutor();
    expect(await executor.execute(command())).toMatchObject({ status: "completed", exitCode: 23 });
    expect(h.attempts).toHaveLength(0);
    expect(await executor.execute(command("after-verification"))).toMatchObject({ status: "completed" });
    expect(h.attempts.map((a) => a.command.commandId)).toEqual(["after-verification"]);
    expect(h.receiptReads).toContainEqual(identity());
  });

  it("a never-started receipt from a different digest cannot authorize local fallback", async () => {
    await seed("starting");
    h.setReceipt(receipt("not_started", { ...identity(), digest: "bad-digest" }));
    const { executor } = h.openExecutor();
    expect(await settled(executor.execute(command()))).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(h.attempts).toHaveLength(0);
  });
  it.each([
    ["company", { companyId: "company-2" }], ["run", { runId: "run-2" }],
    ["command", { commandId: "other" }], ["digest", { digest: "0".repeat(64) }],
    ["VM", { sandboxId: "bx_other" }], ["boot", { guestBootId: "boot-2" }],
    ["generation", { journalGeneration: 2 }],
  ] as const)("a result with the wrong %s cannot release unknown", async (_field, change) => {
    await seed("unknown");
    h.setReceipt(receipt("result", { ...identity(), ...change }));
    const { executor } = h.openExecutor();
    expect(await settled(executor.execute(command()))).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(h.attempts).toHaveLength(0);
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "unknown" });
  });

  it.each([
    null, "not-json", {}, { version: 2, kind: "result", identity: identity(), result: cargoResult },
    { version: 1, kind: "result", identity: identity() },
    { version: 1, kind: "result", identity: identity(), result: { exitCode: "0" } },
  ])("malformed/unavailable receipt holds unknown: %j", async (answer) => {
    await seed("unknown"); h.setReceipt(answer);
    const { executor } = h.openExecutor();
    expect(await settled(executor.execute(command()))).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(h.attempts).toHaveLength(0);
  });

  it("receipt transport failure cannot convert unknown to not_started", async () => {
    await seed("unknown");
    const { executor } = h.openExecutor({ guestReceipts: { read: async () => { throw new Error("guest unreachable"); } } });
    expect(await settled(executor.execute(command()))).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(h.attempts).toHaveLength(0);
  });

  it("restart restores a VM hold before a different command can reserve, stop or GC it", async () => {
    await seed("unknown");
    const { executor } = h.openExecutor();
    method(executor, "recover"); await executor.recover();
    const next = await settled(executor.execute(command("next")));
    expect(next).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(h.attempts).toHaveLength(0);
    await h.advance(120_000);
    await gc(executor);
    await executor.shutdown();
    expect(h.boat.callsOf("stop")).toHaveLength(0);
    expect(h.boat.callsOf("create")).toHaveLength(0);
    expect(h.boat.callsOf("resume")).toHaveLength(0);
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "unknown" });
  });

  it("cancelling unknown is idempotent and cannot erase remote uncertainty", async () => {
    await seed("unknown");
    const { executor } = h.openExecutor(); method(executor, "cancelCommand");
    const first = await executor.cancelCommand("company-1", "run-1", "command-1", "client_signal");
    expect(first).toMatchObject({ state: "unknown", fallbackSafe: false, result: null });
    expect(await executor.cancelCommand("company-1", "run-1", "command-1", "client_signal")).toEqual(first);
    expect(h.attempts).toHaveLength(0);
  });
});

describe("durable host journal: retention and broker-facing semantics", () => {
  it("full result is readable just before 24h; expiry compacts without permitting a replay", async () => {
    await seed("completed");
    const { executor } = h.openExecutor();
    h.clock.t = EPOCH + DAY - 1;
    expect(await view(executor)).toMatchObject({ state: "completed", result: { exitCode: 23 } });
    h.clock.t += 2;
    await gc(executor);
    expect(await settled(executor.execute(command()))).toMatchObject({ code: "OFFLOAD_RESULT_EXPIRED" });
    expect(h.attempts).toHaveLength(0);
    const tomb = await new FileStore(h.hostDirectory).get(hostKey(command()));
    expect(tomb).toMatchObject({ tombstone: true, commandId: "command-1", runId: "run-1", digest: digest(command()), state: "completed" });
    expect((tomb as RecordV1).result).toBeNull();
    expect(JSON.stringify(tomb)).not.toContain("--locked");
  });

  it.each([
    { ageDays: 29, tokenDays: 1, deleted: false },
    { ageDays: 31, tokenDays: 40, deleted: false },
    { ageDays: 31, tokenDays: 1, deleted: true },
  ])("tombstone GC requires both termination+30d AND token expiry: %j", async ({ ageDays, tokenDays, deleted }) => {
    await seed("completed", command(), { tombstone: true, result: null });
    h.runStates.set("run-1", { permanentlyTerminal: true, terminatedAt: EPOCH, tokenExpiresAt: EPOCH + tokenDays * DAY });
    h.clock.t = EPOCH + ageDays * DAY;
    const { executor } = h.openExecutor(); await gc(executor);
    const persisted = await new FileStore(h.hostDirectory).get(hostKey(command()));
    expect(persisted === null).toBe(deleted);
    expect(await settled(executor.execute(command()))).toMatchObject({ code: "OFFLOAD_FORBIDDEN" });
    expect(h.attempts).toHaveLength(0);
  });

  it("even a 90-day-old tombstone remains while its run is not permanently terminal", async () => {
    await seed("completed", command(), { tombstone: true, result: null });
    h.clock.t = EPOCH + 90 * DAY;
    const { executor } = h.openExecutor(); await gc(executor);
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).not.toBeNull();
  });

  it.each(["accepted", "queued", "syncing_in", "starting", "running", "syncing_out", "unknown"] as State[])(
    "wall clock alone never collects unresolved %s, even after permanent run termination", async (state) => {
      await seed(state);
      h.runStates.set("run-1", { permanentlyTerminal: true, terminatedAt: EPOCH, tokenExpiresAt: EPOCH + DAY });
      h.clock.t = EPOCH + 365 * DAY;
      const { executor } = h.openExecutor(); await gc(executor);
      const persisted = await new FileStore(h.hostDirectory).get(hostKey(command()));
      expect(persisted).toMatchObject({ state });
      expect(persisted).not.toMatchObject({ tombstone: true });
    },
  );

  it("read is effect-free and returns the broker result shape, including a real nonzero exit", async () => {
    await seed("completed");
    const { executor } = h.openExecutor();
    const first = await view(executor); const second = await view(executor);
    expect(first).toMatchObject({ version: 1, commandId: "command-1", state: "completed", remoteStarted: true, fallbackSafe: false, result: wireResult });
    expect(second).toEqual(first);
    expect(h.attempts).toHaveLength(0);
    expect(h.boat.callsOf("create")).toHaveLength(0);
  });

  it.each(["cancelled", "failed", "not_started"] as State[])("retains and replays terminal alternative %s without dispatch", async (state) => {
    await seed(state, command(), {
      result: { status: state, commandId: "command-1", remoteStarted: state !== "not_started", fallbackSafe: state === "not_started" },
    });
    const { executor } = h.openExecutor();
    expect(await settled(executor.execute(command()))).toMatchObject({ status: state, fallbackSafe: state === "not_started" });
    expect(h.attempts).toHaveLength(0);
  });

  it("queued cancellation durably prevents later start and duplicate cancellation is stable", async () => {
    await seed("queued");
    const { executor } = h.openExecutor(); method(executor, "cancelCommand");
    const first = await executor.cancelCommand("company-1", "run-1", "command-1", "client_signal");
    expect(first).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    expect(await new FileStore(h.hostDirectory).get(hostKey(command()))).toMatchObject({ state: "not_started" });
    expect(await executor.cancelCommand("company-1", "run-1", "command-1", "client_signal")).toEqual(first);
    h.crash();
    expect(await settled(h.openExecutor().executor.execute(command()))).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(h.attempts).toHaveLength(0);
  });
});
