// Missing/delayed registration cannot relinquish ownership of timed-out work.
// Gates control ordering; no probabilistic sub-millisecond SSH race is used.
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { waitFor } from "./test-support/local-sync-ssh.js";
import { OwnedRemoteWork, stopGateWorker } from "./test-support/owned-remote-work.js";

const boundary = vi.hoisted(() => ({
  gate: undefined as { root: string; mode: "marker" | "startup"; relay: string } | undefined,
  interceptions: 0,
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: Parameters<typeof spawn>) => {
    const gate = boundary.gate;
    if (args[0] !== "ssh" || !gate) return actual.spawn(...args);
    boundary.gate = undefined; // Cancellation and subsequent commands use SSH directly.
    boundary.interceptions++;
    return actual.spawn("python3", [gate.relay, "relay", gate.root, gate.mode, "ssh", ...(args[1] as string[])], args[2]);
  } };
});

// Gates, not a short timeout race, establish the ordering. Leave enough time
// for the fixture's bounded 8s readiness checks, then let the REAL deadline
// expire with registration/startup still held. Do not fast-forward only a
// local timer: a valid fix may also enforce an absolute deadline remotely.
const deadlineMs = 10000;

let fixture: LoopbackSsh;
let work: OwnedRemoteWork | undefined;
let gateRoot: string | undefined;
beforeEach(async () => {
  boundary.gate = undefined; boundary.interceptions = 0;
  fixture = new LoopbackSsh(); await fixture.start();
  work = new OwnedRemoteWork(fixture.root);
});
afterEach(async () => {
  boundary.gate = undefined;
  vi.restoreAllMocks();
  try {
    if (gateRoot) await stopGateWorker(gateRoot);
  } finally {
    try { await work?.cleanup(); }
    finally { await fixture?.cleanup(); work = undefined; gateRoot = undefined; }
  }
});

async function arm(mode: "marker" | "startup") {
  gateRoot = path.join(fixture.root, "gate");
  await mkdir(gateRoot);
  boundary.gate = { root: gateRoot, mode, relay: fileURLToPath(new URL("./test-support/gated-openssh.py", import.meta.url)) };
  return gateRoot;
}

async function sameMaster(masterPid: number | undefined) {
  const { manager, session } = fixture;
  expect.soft(manager.masterAlive(session)).toBe(true);
  expect.soft(session.master!.pid).toBe(masterPid);
  expect.soft(await manager.runStream(session, "printf reusable", { timeoutMs: 3000 })).toMatchObject({
    exitCode: 0, timedOut: false, stdout: "reusable",
  });
  expect.soft(session.master!.pid).toBe(masterPid);
}

it("deadline after payload startup but before marker delivery kills remote work before returning", async () => {
  const root = await arm("marker");
  const { manager, session } = fixture;
  const masterPid = session.master!.pid;
  const owned = work!;
  let returned = false;
  const pending = manager.runStream(session, owned.command(), { timeoutMs: deadlineMs });
  const observed = pending.then((result) => { returned = true; return { result, atReturn: owned.snapshot() }; });
  await owned.started();
  await waitFor(() => existsSync(path.join(root, "stderr-held")), "relay never intercepted remote registration bytes");
  expect(returned, "setup must prove payload startup and missing registration BEFORE deadline completion").toBe(false);
  expect(boundary.interceptions).toBe(1);
  expect(existsSync(path.join(root, "stderr-delivered")), "no registration/control stderr reached SshManager before deadline").toBe(false);
  expect((await readFile(path.join(root, "stderr"))).length).toBeGreaterThan(0);
  expect(owned.snapshot()).toEqual({ shell: true, descendant: true });
  const outcome = await observed;
  expect.soft(outcome.result.timedOut, "preserve timeout-result semantics, not a thrown stream failure").toBe(true);
  expect.soft(outcome.result.exitCode).not.toBe(0);
  expect.soft(outcome.atReturn, "missing marker cannot leave the remote group alive at timeout completion").toEqual({ shell: false, descendant: false });
  await sameMaster(masterPid);
  expect.soft(await owned.pastScheduledWrite(), "no post-timeout scheduled write, checked after its real due time").toBe(false);
  expect.soft(owned.snapshot()).toEqual({ shell: false, descendant: false });
}, 30000);

it("deadline before remote startup prevents a delayed, already-submitted SSH command from executing afterward", async () => {
  const root = await arm("startup");
  const { manager, session } = fixture;
  const masterPid = session.master!.pid;
  const owned = work!;
  let returned = false;
  const pending = manager.runStream(session, owned.command(), { timeoutMs: deadlineMs }).then((result) => { returned = true; return result; });
  await waitFor(() => existsSync(path.join(root, "startup-held")), "real SSH startup was not gated");
  expect(returned, "startup gate must be established before timeout completion").toBe(false);
  expect(existsSync(path.join(root, "ssh.pid"))).toBe(false);
  expect(existsSync(owned.shellPid)).toBe(false);
  expect(boundary.interceptions).toBe(1);
  const result = await pending;
  expect.soft(result.timedOut).toBe(true);
  expect.soft(result.exitCode).not.toBe(0);
  // Release only AFTER the timed-out call returned. The submitted worker
  // ignores no remote semantics and forwards no local termination signals.
  await writeFile(path.join(root, "startup-release"), "release after timeout");
  await waitFor(() => existsSync(path.join(root, "ssh.pid")), "delayed real OpenSSH was never launched");
  // A correct remote admission fence may exit without ever starting payload.
  await waitFor(() => existsSync(owned.ready) || existsSync(path.join(root, "exit.json")), "late SSH neither completed nor started payload");
  expect.soft(existsSync(owned.shellPid), "late-starting payload must not execute at all after timeout returned").toBe(false);
  if (existsSync(owned.ready)) {
    await owned.started();
    expect.soft(owned.snapshot(), "late registration must not resurrect cancelled work").toEqual({ shell: false, descendant: false });
    expect.soft(await owned.pastScheduledWrite(), "wait beyond actual late-started write deadline").toBe(false);
  }
  expect.soft(existsSync(owned.late)).toBe(false);
  await sameMaster(masterPid);
}, 30000);

it("normal fast commands preserve exit status and binary streams over the same real shared master", async () => {
  const { manager, session } = fixture;
  const masterPid = session.master!.pid;
  expect(await manager.runStream(session, "printf fast; exit 19", { timeoutMs: 3000 })).toMatchObject({
    exitCode: 19, timedOut: false, stdout: "fast",
  });
  const bytes = Buffer.from([0, 255, 128, 10, 0, 13]);
  const parts: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { parts.push(Buffer.from(chunk)); done(); } });
  expect(await manager.runStream(session, "cat", { stdin: Readable.from([bytes]), stdout: sink, timeoutMs: 3000 })).toMatchObject({
    exitCode: 0, timedOut: false, stdout: "",
  });
  expect(Buffer.concat(parts)).toEqual(bytes);
  await sameMaster(masterPid);
  expect(boundary.interceptions).toBe(0);
}, 15000);
