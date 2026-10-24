import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as offload from "./offload.js";
import {
  EPOCH, FileStore, cargoResult, command, guestKey, identity, receipt, settled,
  type Command, type Identity, type Receipt,
} from "./test-support/durable-offload.js";

// Explicit missing-surface RED, never a static import of a nonexistent module.
// This is a production guest-runner boundary, not a production test-only hook:
// the same durable KV primitive can be backed by confined guest filesystem IO.
interface Runner {
  run(id: Identity, cmd: Command): Promise<unknown>;
}
interface RunnerDeps {
  store: FileStore; now(): number;
  spawn(cmd: Command, id: Identity): Promise<typeof cargoResult>;
}
function runner(deps: RunnerDeps): Runner {
  const Constructor = (offload as unknown as { OffloadGuestRunner?: new (deps: RunnerDeps) => Runner }).OffloadGuestRunner;
  expect(typeof Constructor, "missing production surface: OffloadGuestRunner").toBe("function");
  return new Constructor!(deps);
}
let root: string;
beforeEach(async () => { root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "guest-receipts-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup() {
  const effects: Array<{ cmd: Command; id: Identity; marker: unknown; started: unknown }> = [];
  const spawn = async (cmd: Command, id: Identity) => {
    const disk = new FileStore(root);
    effects.push({ cmd, id, marker: await disk.get(guestKey(id, "marker")), started: await disk.get(guestKey(id, "started")) });
    return { ...cargoResult };
  };
  const open = (store = new FileStore(root)) => runner({ store, spawn, now: () => EPOCH });
  return { effects, spawn, open };
}

describe("guest receipt durability (missing surface until builder implements runner)", () => {
  it("exclusive marker and durable started receipt exist on disk before the first command effect", async () => {
    const s = setup(); const store = new FileStore(root);
    const result = await s.open(store).run(identity(), command());
    expect(result).toMatchObject({ status: "completed", exitCode: 23 });
    expect(s.effects).toHaveLength(1);
    expect(s.effects[0].marker).toMatchObject({ version: 1, kind: "marker", identity: identity() });
    expect(s.effects[0].started).toMatchObject({ version: 1, kind: "started", identity: identity() });
    expect(store.writes.map((w) => (w.value as Receipt).kind)).toEqual(["marker", "started", "result"]);
    expect(await new FileStore(root).get(guestKey(identity(), "result")))
      .toMatchObject({ version: 1, kind: "result", identity: identity(), result: cargoResult });
  });

  it("two independent runners racing an exclusive ID marker produce exactly one effect", async () => {
    const s = setup();
    const results = await Promise.all([
      settled(s.open().run(identity(), command())), settled(s.open().run(identity(), command())),
    ]);
    expect(s.effects).toHaveLength(1);
    expect(results.some((result) => (result as { status?: string }).status === "completed")).toBe(true);
    expect(results.every((result) => (result as { status?: string }).status === "completed"
      || (result as { code?: string }).code === "OFFLOAD_EXECUTION_UNKNOWN")).toBe(true);
    const disk = new FileStore(root);
    expect(await disk.get(guestKey(identity(), "result"))).toMatchObject({ identity: identity(), result: cargoResult });
    expect(await s.open().run(identity(), command())).toMatchObject({ status: "completed", exitCode: 23 });
    expect(s.effects).toHaveLength(1);
  });

  it("a durable never-started fence prevents even a delayed original dispatch", async () => {
    const s = setup(); const store = new FileStore(root);
    await store.create(guestKey(identity(), "marker"), receipt("marker"));
    await store.set(guestKey(identity(), "not_started"), receipt("not_started"));
    expect(await s.open().run(identity(), command()))
      .toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.effects).toHaveLength(0);
    expect(await s.open().run(identity(), command()))
      .toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.effects).toHaveLength(0);
  });

  it("a lost successful reply is recovered from a newly opened result receipt, not another spawn", async () => {
    const s = setup();
    const first = await s.open().run(identity(), command());
    const replay = await s.open(new FileStore(root)).run(identity(), command());
    expect(replay).toEqual(first);
    expect(s.effects).toHaveLength(1);
  });

  it("the same client ID in another run claims a different exclusive marker", async () => {
    const s = setup();
    await s.open().run(identity(), command());
    const other = command("command-1", { runId: "run-2" });
    await s.open().run(identity(other), other);
    expect(s.effects.map((effect) => effect.id.runId)).toEqual(["run-1", "run-2"]);
  });

  it("an already claimed ID with a changed payload cannot execute", async () => {
    const s = setup(); await s.open().run(identity(), command());
    const changed = command("command-1", { argv: ["build"] });
    expect(await settled(s.open().run(identity(changed), changed)))
      .toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    expect(s.effects).toHaveLength(1);
  });

  it.each(["marker", "started"])("failed durable %s write forbids spawn", async (kind) => {
    const s = setup(); const store = new FileStore(root);
    store.fail = (_key, value) => (value as Receipt | null)?.kind === kind;
    await settled(s.open(store).run(identity(), command()));
    expect(s.effects).toHaveLength(0);
    if (kind === "started") {
      // Exclusive marker survives the gap. A new runner must hold it, not
      // interpret absence of started/result as proof it owns a new execution.
      expect(await new FileStore(root).get(guestKey(identity(), "marker"))).not.toBeNull();
      expect(await settled(s.open().run(identity(), command())))
        .toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
      expect(s.effects).toHaveLength(0);
    }
  });

  it.each(["marker", "started"])("restart with %s only is ambiguous and never claims a second execution", async (kind) => {
    const s = setup(); const store = new FileStore(root);
    await store.create(guestKey(identity(), "marker"), receipt("marker"));
    if (kind === "started") await store.set(guestKey(identity(), "started"), receipt("started"));
    expect(await settled(s.open().run(identity(), command())))
      .toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
    expect(s.effects).toHaveLength(0);
    expect(await store.get(guestKey(identity(), "marker"))).not.toBeNull();
  });

  it("an effect with a lost result commit is held after restart, never respawned", async () => {
    const s = setup(); const store = new FileStore(root);
    store.fail = (_key, value) => (value as Receipt | null)?.kind === "result";
    await settled(s.open(store).run(identity(), command()));
    expect(s.effects).toHaveLength(1);
    expect(await new FileStore(root).get(guestKey(identity(), "result"))).toBeNull();
    expect(await settled(s.open().run(identity(), command())))
      .toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
    expect(s.effects).toHaveLength(1);
  });

  it("a spawn exception after a possible side effect cannot erase the exclusive marker", async () => {
    const store = new FileStore(root); let effects = 0;
    const first = runner({ store, now: () => EPOCH, spawn: async () => { effects++; throw new Error("reply lost after effect"); } });
    await settled(first.run(identity(), command()));
    const second = runner({ store: new FileStore(root), now: () => EPOCH, spawn: async () => { effects++; return cargoResult; } });
    expect(await settled(second.run(identity(), command())))
      .toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
    expect(effects).toBe(1);
    expect(await store.get(guestKey(identity(), "marker"))).not.toBeNull();
  });

  it.each([
    { ...receipt("result"), identity: { ...identity(), digest: "bad-digest" } },
    { ...receipt("result"), identity: { ...identity(), guestBootId: "rebooted" } },
    { version: 1, kind: "result", identity: identity(), result: { exitCode: "0" } },
  ])("malformed or mismatched terminal receipt cannot release an existing marker: %j", async (bad) => {
    const s = setup(); const store = new FileStore(root);
    await store.create(guestKey(identity(), "marker"), receipt("marker"));
    await store.set(guestKey(identity(), "result"), bad);
    expect(await settled(s.open().run(identity(), command())))
      .toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN" });
    expect(s.effects).toHaveLength(0);
  });
});
