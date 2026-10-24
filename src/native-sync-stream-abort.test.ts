// A thrown pipe/cap failure must own remote cancellation just like a deadline.
// The stubborn descendant makes local SSH-client termination insufficient.
import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shellQuote } from "./shell.js";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { OwnedRemoteWork } from "./test-support/owned-remote-work.js";

let fixture: LoopbackSsh;
let work: OwnedRemoteWork | undefined;
beforeEach(async () => { fixture = new LoopbackSsh(); await fixture.start(); work = new OwnedRemoteWork(fixture.root); });
afterEach(async () => {
  try { await work?.cleanup(); }
  finally { await fixture?.cleanup(); work = undefined; }
});

for (const failure of ["consumer", "stderr cap", "stdout cap"] as const) {
  it(`${failure} preserves its failure and kills remote shell/ignoring descendant before rejection, retaining the same master`, async () => {
    const { manager, session } = fixture;
    const owned = work!;
    const masterPid = session.master!.pid;
    const sinkFailure = new Error("PUBLIC_DUMMY_CONSUMER_FAILURE");
    let sinkCalled = false;
    const sink = new Writable({ write(_chunk, _encoding, done) { sinkCalled = true; done(sinkFailure); } });
    const output = failure === "consumer" ? "printf consumer-ready"
      : `python3 -c ${shellQuote(`import os; os.write(${failure === "stderr cap" ? 2 : 1}, b'x' * 300000)`)}`;
    const pending = manager.runStream(session, owned.command(output), {
      timeoutMs: 10000, ...(failure === "consumer" ? { stdout: sink } : {}),
      // Deliberately no maxOutputBytes override: test the default 256 KiB cap.
    });
    // Take the liveness snapshot in the rejection handler, before other awaits
    // or teardown can make a late cancellation look timely.
    const observed = pending.then(
      (result) => ({ result, error: undefined, atReturn: owned.snapshot() }),
      (error: unknown) => ({ result: undefined, error, atReturn: owned.snapshot() }),
    );
    await owned.started();
    const outcome = await observed;
    expect.soft(outcome.result, "a stream failure must reject, never become a success/timeout result").toBeUndefined();
    if (failure === "consumer") {
      expect.soft(sinkCalled).toBe(true);
      expect.soft(outcome.error, "preserve the original consumer failure").toBe(sinkFailure);
    } else {
      expect.soft(outcome.error).toBeInstanceOf(Error);
      expect.soft(String(outcome.error), "preserve the original output-cap failure").toMatch(/output.*(exceed|limit|cap)|exceed.*output/i);
    }
    expect.soft(outcome.atReturn, "remote work must already be dead at rejection, including graceful-signal-ignoring child").toEqual({ shell: false, descendant: false });
    expect.soft(manager.masterAlive(session)).toBe(true);
    expect.soft(session.master!.pid).toBe(masterPid);
    expect.soft(await manager.runStream(session, "printf same-master-reusable", { timeoutMs: 3000 })).toMatchObject({
      exitCode: 0, timedOut: false, stdout: "same-master-reusable",
    });
    expect.soft(session.master!.pid).toBe(masterPid);
    expect.soft(await owned.pastScheduledWrite(), "waited past the actual descendant write deadline: no write may occur after rejection").toBe(false);
    expect.soft(existsSync(owned.late)).toBe(false);
    expect.soft(owned.snapshot()).toEqual({ shell: false, descendant: false });
    sink.destroy();
  }, 20000);
}
