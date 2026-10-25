import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, fixture, flush, until } from "./test-support/offload-lifecycle-contract.js";
import type { Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

// Breaks caught: releasing on Cargo exit instead of stage completion; using only
// the VM lock rather than a workspace reservation; choosing incompatible VMs.
// slice c: sync-inclusive workspace reservations and pool compatibility.
describe("offload lifecycle: sync-inclusive reservations", () => {
  it("pushes, executes, collects and stages in order without writing the live workspace", async () => {
    await writeFile(join(s.liveRoot, "Cargo.lock"), "concurrent local edit\n");
    const result = await s.execute(command("ordered"));
    expect.soft(s.trace).toEqual(["push:ordered", "exec:ordered", "collect:ordered", "stage:ordered"]);
    expect.soft(result).toMatchObject({ syncBack: { state: "staged", artifactId: "artifact-ordered" } });
    expect(await readFile(join(s.liveRoot, "Cargo.lock"), "utf8")).toBe("concurrent local edit\n");
    // This proves orchestration and no executor write, not the separate real
    // sync adapter's symlink/path-confinement implementation.
  });

  it.each(["push", "collect", "stage"])("holds the workspace and VM through asynchronous %s", async (phase) => {
    const gate = s.hold(`${phase}:first`);
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("first"), ex);
    for (let i = 0; i < 20; i += 1) await flush();
    const second = s.execute(command("second"), ex);
    await s.clock.advance(15_000);
    // No queue handoff or idle stop is allowed while this phase is held.
    expect.soft(s.trace).toContain(`${phase}:first`);
    expect.soft(s.starts.filter((v) => v.commandId === "second")).toEqual([]);
    expect.soft(s.boat.callsOf("stop")).toEqual([]);
    if (phase === "push") expect.soft(s.starts).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(s.trace.indexOf("stage:first")).toBeLessThan(s.trace.indexOf("push:second"));
  });

  it("serializes the same execution workspace even when two VMs are free", async () => {
    const gate = s.hold("exec:first");
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("first"), ex);
    await until(() => s.trace.includes("exec:first"));
    const second = s.execute(command("second"), ex);
    await s.clock.advance(1);
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["first"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(s.starts.map((v) => v.commandId)).toEqual(["first", "second"]);
  });

  it("allows a different permitted workspace to progress while another executes", async () => {
    const gate = s.hold("exec:first");
    const ex = s.make({ maxOffloadVms: 2 });
    const first = s.execute(command("first"), ex);
    await until(() => s.trace.includes("exec:first"));
    await s.execute(command("other", { cardId: "card-b", executionWorkspaceId: "workspace-b" }), ex);
    expect(s.starts.map((v) => v.commandId)).toEqual(["first", "other"]);
    expect(s.guest.alive("first")).toBe(true);
    gate.resolve();
    await first;
  });

  it.each([
    { companyId: "company-b" }, { repoId: "repo-b" },
    { profileId: "rust-other" }, { trustDomainId: "untrusted-fork" },
  ])("never borrows a VM from an incompatible pool: %j", async (identity) => {
    const ex = s.make({ maxOffloadVms: 2 });
    const first = await s.execute(command("first"), ex);
    const other = await s.execute(command("other", identity), ex);
    expect(first.status).toBe("completed");
    expect(other.status).toBe("completed");
    expect(s.starts[1]?.sandboxId).not.toBe(s.starts[0]?.sandboxId);
  });

  it("a failed push has no command effect and is durably never-started", async () => {
    s.fail.add("push:failed");
    const result = await s.execute(command("failed"));
    expect.soft(s.starts).toEqual([]);
    expect.soft(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(JSON.stringify(await s.state.all())).toContain("not_started");
  });

  it.each(["collect", "stage"])("a failed %s never erases execution into safe fallback", async (phase) => {
    s.fail.add(`${phase}:failed`);
    const result = await s.execute(command("failed"));
    expect.soft(s.trace).toContain(`${phase}:failed`);
    expect.soft(result.status).not.toBe("completed");
    expect.soft(result).toMatchObject({ remoteStarted: true, fallbackSafe: false });
    const replay = await s.execute(command("failed"));
    expect(replay).toEqual(result);
    expect(s.starts).toHaveLength(1);
  });

});

describe("offload lifecycle: queued cancellation and idle fencing", () => {
  it("cancelled queued work is durably never-started and cannot dispatch after capacity returns", async () => {
    const gate = s.hold("exec:holder");
    const first = s.execute(command("holder"));
    await until(() => s.trace.includes("exec:holder"));
    const queued = s.execute(command("queued", { cardId: "card-b", executionWorkspaceId: "workspace-b" }));
    await flush();
    await s.api().cancel?.("queued", "client_signal", 1);
    await s.api().cancel?.("queued", "client_signal", 1);
    gate.resolve();
    await first;
    const receipt = await queued;
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["holder"]);
    expect.soft(receipt).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(JSON.stringify(await s.state.all())).toContain("not_started");
  });

  // slice c: cancellation must retain an asynchronous sync reservation.
  describe("slice c: cancellation during sync", () => {
  it.each(["push", "collect", "stage"])("cancellation during %s cannot hand off before the asynchronous phase settles", async (phase) => {
    const gate = s.hold(`${phase}:cancelled`);
    const first = s.execute(command("cancelled"));
    for (let n = 0; n < 20; n += 1) await flush();
    const cancel = s.api().cancel?.("cancelled", "client_signal", 1).catch(() => undefined);
    const next = s.execute(command("next"));
    await s.clock.advance(15_000);
    expect.soft(s.trace).toContain(`${phase}:cancelled`);
    expect.soft(s.starts.filter((v) => v.commandId === "next")).toEqual([]);
    expect.soft(s.boat.callsOf("stop")).toEqual([]);
    gate.resolve();
    await cancel;
    await first;
    await next;
  });

  });

  it("a callback already dequeued for an old generation cannot stop a new reservation", async () => {
    await s.execute(command("old"));
    const stale = [...s.clock.timers.values()].filter((v) => v.at === s.clock.t + 15_000).map((v) => v.cb);
    expect(stale.length).toBeGreaterThan(0);
    const gate = s.hold("exec:new");
    const newer = s.execute(command("new"));
    await until(() => s.trace.includes("exec:new"));
    for (const callback of stale) callback();
    await flush();
    expect(s.boat.callsOf("stop")).toEqual([]);
    expect(s.guest.alive("new")).toBe(true);
    gate.resolve();
    await newer;
  });
});
