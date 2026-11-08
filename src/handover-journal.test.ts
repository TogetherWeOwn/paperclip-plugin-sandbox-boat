import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStore, command, record, receipt, hostKey, EPOCH } from "./test-support/durable-offload.js";
import { openHandoverSources } from "./test-support/handover-sources.js";

let root: string, sources: Awaited<ReturnType<typeof openHandoverSources>>;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "handover-journal-")); sources = await openHandoverSources(); });
afterEach(async () => { await sources.close(); await rm(root, { recursive: true, force: true }); });
const pairs = [["old", "candidate"], ["candidate", "old"]] as const;
async function reopen() { await sources.close(); sources = await openHandoverSources(); }
async function journal(version: "old" | "candidate", answer: unknown = null, lifecycle = false) {
  const { OffloadJournal } = await sources[version].load("src/offload-journal.ts");
  const hold = vi.fn(async () => {}), release = vi.fn(async () => {});
  const stage = vi.fn(async () => ({ state: "staged", changedPaths: ["result.txt"], conflictPaths: [], artifactId: "synthetic-artifact" }));
  const instance = new OffloadJournal({ journalStore: new FileStore(root), guestReceipts: { read: async () => answer },
    resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + 86_400_000 }),
    sync: { push: async () => {}, collect: async () => ({ synthetic: true }), stage, discard: async () => {}, markSuspect: async () => {} },
  }, () => EPOCH + 1000, { hold, release, cancel: async () => {} }, lifecycle ? {
    prepare: async (_sandbox: string, _command: unknown, base: unknown) => base,
    discard: () => {}, cancel: async () => {}, heartbeat: () => {},
  } : undefined);
  return { instance, hold, release, stage };
}

describe("pinned journal process-boundary semantics", () => {
  it.each(pairs)("%s → %s retains both synthetic historical UNKNOWN shapes without replay or false completion", async (from, to) => {
    for (const remoteStarted of [true, null]) {
      const cmd = command(`unknown-${String(remoteStarted)}`);
      const seeded = record("unknown", cmd);
      seeded.remoteStarted = remoteStarted;
      seeded.result = { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: cmd.commandId,
        sandboxId: seeded.identity!.sandboxId, warm: "cold", queueWaitMs: 0, remoteStarted,
        fallbackSafe: false, exitCode: 75, seconds: 1, dollars: 0, reason: "synthetic lost reply" };
      await new FileStore(root).set(hostKey(cmd), seeded);
      const first = await journal(from, null, true);
      const launch = vi.fn(async () => { throw new Error("must never dispatch unknown"); });
      expect(await first.instance.execute(cmd, launch)).toEqual(seeded.result);
      const persisted = await new FileStore(root).get(hostKey(cmd));
      await reopen();
      const next = await journal(to, null, true);
      expect(await next.instance.execute(cmd, launch)).toEqual(seeded.result);
      expect(launch).not.toHaveBeenCalled();
      expect(next.hold).toHaveBeenCalledWith(seeded.identity, cmd);
      expect(next.release).not.toHaveBeenCalled();
      expect(next.stage).not.toHaveBeenCalled();
      expect(await new FileStore(root).get(hostKey(cmd))).toEqual(persisted);
      const changedScope = { ...cmd, runId: "other-run" };
      await expect(next.instance.readCommand(cmd.companyId, changedScope.runId, cmd.commandId)).rejects.toThrow();
      expect(await next.instance.hasUnsettled(seeded.identity!.sandboxId)).toBe(true);
    }
  });

  it.each(pairs)("%s → %s recovers a delayed matching receipt and retains the staged artifact on the return trip", async (from, to) => {
    const cmd = command("delayed-receipt"), seeded = record("running", cmd);
    await new FileStore(root).set(hostKey(cmd), seeded);
    const first = await journal(from);
    const launch = vi.fn(async () => { throw new Error("must not redispatch"); });
    expect(await first.instance.execute(cmd, launch)).toMatchObject({ status: "unknown", fallbackSafe: false });
    await reopen();
    const next = await journal(to, receipt("result", seeded.identity!));
    const result = await next.instance.execute(cmd, launch);
    expect(result).toMatchObject({ status: "completed", exitCode: 23,
      syncBack: { state: "staged", artifactId: "synthetic-artifact", changedPaths: ["result.txt"] } });
    expect(next.stage).toHaveBeenCalledTimes(1);
    expect(next.release).toHaveBeenCalledTimes(1);
    await reopen();
    const returned = await journal(from);
    expect(await returned.instance.execute(cmd, launch)).toEqual(result);
    expect(returned.stage).not.toHaveBeenCalled();
    expect(returned.hold).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(pairs)("%s → %s refuses a mismatched receipt without releasing isolation", async (from, to) => {
    const cmd = command("foreign-receipt"), seeded = record("running", cmd);
    await new FileStore(root).set(hostKey(cmd), seeded);
    await (await journal(from)).instance.recover();
    await reopen();
    const next = await journal(to, receipt("result", { ...seeded.identity!, guestBootId: "foreign-boot" }));
    const launch = vi.fn();
    expect(await next.instance.execute(cmd, launch)).toMatchObject({ status: "unknown", fallbackSafe: false });
    expect(next.release).not.toHaveBeenCalled();
    expect(next.stage).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await new FileStore(root).get(hostKey(cmd))).toMatchObject({ identity: seeded.identity, resultAt: null });
  });
});
