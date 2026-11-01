// Timeouts must actually end the call, not just set a flag:
// - SshManager.run() over a live ControlMaster (killing the local slave is
//   not enough; the master holds the channel until the remote job exits);
// - the rsync delta push, whose ssh transport is a grandchild that inherits
//   the stderr pipe and outlives a killed rsync;
// - runProcess, which also decodes output once so a multi-byte UTF-8
//   sequence split across pipe reads survives.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshGuestStore } from "./offload-ssh-guest-store.js";
import { buildRsyncPushArgs, renderFilesFromList } from "./offload-sync.js";
import { shellQuote } from "./shell.js";
import { runProcess, runStreamProcess } from "./ssh.js";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";

const execFileAsync = promisify(execFile);

function pidRunning(pid: number): boolean {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function sshClientPids(controlPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", controlPath]);
    return stdout.trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

describe("runProcess (local)", () => {
  it("decodes a multi-byte UTF-8 sequence split across chunks exactly", async () => {
    const script = "import os, time\nos.write(1, b'\\xe2')\ntime.sleep(0.1)\nos.write(1, b'\\x82\\xac')\n";
    const result = await runProcess("python3", ["-c", script], { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("€");
    expect(result.stdout).not.toContain("�");
  }, 10_000);

  it("resolves at timeout instead of waiting for the remote-paced pipe EOF", async () => {
    const start = Date.now();
    const result = await runProcess("sh", ["-c", "sleep 5"], { timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(1_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 10_000);

  it("a SIGTERM-ignoring descendant still gets the group SIGKILL after the parent closes", async () => {
    const dir = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "grp-"));
    const pidFile = path.join(dir, "child.pid");
    const script = [
      "import os, pathlib, signal, sys, time",
      "pid = os.fork()",
      "if pid == 0:",
      "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "    pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))",
      "    while True: time.sleep(30)",
      "while True: time.sleep(30)",
    ].join("\n");
    const result = await runStreamProcess("python3", ["-c", script, pidFile], { timeoutMs: 800, killProcessGroup: true });
    expect(result.timedOut).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 2_000;
    while (pidRunning(childPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(pidRunning(childPid)).toBe(false);
  }, 15_000);

  it("resolves on exit even when a background grandchild keeps the pipes open", async () => {
    const start = Date.now();
    const result = await runProcess("sh", ["-c", "(sleep 5) & echo x"], { timeoutMs: 10_000 });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "x\n" });
  }, 15_000);
});

describe("SshManager.run() over a live ControlMaster (loopback sshd)", () => {
  let fixture: LoopbackSsh;
  beforeEach(async () => { fixture = new LoopbackSsh(); await fixture.start(); });
  afterEach(async () => { await fixture?.cleanup(); });

  it("keeps the plain contract: stdin in, stdout and exit code out", async () => {
    const { manager, session } = fixture;
    await expect(manager.run(session, "cat", { stdin: "hello €", timeoutMs: 5_000 }))
      .resolves.toMatchObject({ exitCode: 0, timedOut: false, stdout: "hello €" });
    await expect(manager.run(session, "exit 3", { timeoutMs: 5_000 }))
      .resolves.toMatchObject({ exitCode: 3, timedOut: false });
  }, 15_000);

  it("a command that exits without reading a large stdin returns its status, never a thrown EPIPE", async () => {
    const { manager, session } = fixture;
    await expect(manager.run(session, "exit 3", { stdin: "x".repeat(16 * 1024 * 1024), timeoutMs: 10_000 }))
      .resolves.toMatchObject({ exitCode: 3, timedOut: false });
  }, 20_000);

  it("sleep 5 with timeoutMs 500 returns near the deadline, remote PID dead, master alive", async () => {
    const { manager, session } = fixture;
    const masterPid = session.master!.pid;
    const pidFile = path.join(fixture.root, "run-sleep.pid");
    const start = Date.now();
    const result = await manager.run(session, `echo $$ > ${shellQuote(pidFile)}; exec sleep 5`, { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    const remotePid = Number(readFileSync(pidFile, "utf8"));
    expect(pidRunning(remotePid)).toBe(false);
    expect(manager.masterAlive(session)).toBe(true);
    expect(session.master!.pid).toBe(masterPid);
    await expect(manager.run(session, "printf again", { timeoutMs: 3_000 }))
      .resolves.toMatchObject({ exitCode: 0, stdout: "again" });
  }, 20_000);

  it("(sleep 5) & echo x: a background job holding stderr cannot postpone the timeout", async () => {
    const { manager, session } = fixture;
    const masterPid = session.master!.pid;
    const pidFile = path.join(fixture.root, "run-bg.pid");
    const start = Date.now();
    const result = await manager.run(
      session,
      `(sleep 5) & echo $! > ${shellQuote(pidFile)}; echo x; wait`,
      { timeoutMs: 500 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_500);
    expect(result.timedOut).toBe(true);
    const remotePid = Number(readFileSync(pidFile, "utf8"));
    expect(pidRunning(remotePid)).toBe(false);
    expect(manager.masterAlive(session)).toBe(true);
    expect(session.master!.pid).toBe(masterPid);
  }, 20_000);

  it("a timed-out guest-store push kills the stalled guest receiver before releasing, then a clean push lands", async () => {
    const { manager, session } = fixture;
    const snapshot = path.join(fixture.root, "snap2");
    const guestDir = path.join(fixture.root, `paperclip-boat-mirror-${"c".repeat(32)}`);
    await mkdir(snapshot, { recursive: true });
    await mkdir(guestDir, { recursive: true });
    await writeFile(path.join(snapshot, "file.txt"), "payload");
    const entry = { path: "file.txt", size: 7, mtimeMs: 0, mode: 0o644, sha256: "0".repeat(64) };
    // Stall only through the store's spawn seam: same argv the store built,
    // a sleeping remote rsync, and a 1 s budget instead of the store's 300 s.
    // The remote sleep records its own PID (guest == this machine) so the
    // assertion names that exact process; a host-wide `pgrep -f "sleep 20"`
    // also matches unrelated processes on a shared machine.
    const pidFile = path.join(fixture.root, "stalled-push.pid");
    const stalledStore = new SshGuestStore({
      ssh: manager,
      session,
      spawn: async (command, args, opts) => {
        const stalled = [`--rsync-path=sleep 20 & echo $! > '${pidFile}'; wait; rsync`, ...args];
        const r = await runStreamProcess(command, stalled, { stdin: opts.stdin, timeoutMs: 1_000, killProcessGroup: true });
        return { exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut };
      },
    });
    const start = Date.now();
    await expect(stalledStore.push(snapshot, [entry], guestDir)).rejects.toThrow(/delta push failed/);
    // push() settles only after its guest-side kill, well before the 20 s
    // stall would end on its own: the stalled remote sleep must be dead now
    // (a brief poll absorbs exit-in-flight, still far below 20 s).
    expect(Date.now() - start).toBeLessThan(10_000);
    const stalledPid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 2_000;
    while (pidRunning(stalledPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(pidRunning(stalledPid)).toBe(false);
    const cleanStore = new SshGuestStore({ ssh: manager, session });
    await expect(cleanStore.push(snapshot, [entry], guestDir)).resolves.toMatchObject({ files: 1 });
    expect(await readFile(path.join(guestDir, "file.txt"), "utf8")).toBe("payload");
  }, 30_000);

  it("a stalling rsync push returns timedOut promptly, leaves no ssh client, and a second push proceeds", async () => {
    const { session } = fixture;
    const masterPid = session.master!.pid!;
    const snapshot = path.join(fixture.root, "snapshot");
    const guestDir = path.join(fixture.root, "guest-mirror");
    await mkdir(snapshot, { recursive: true });
    await mkdir(guestDir, { recursive: true });
    await writeFile(path.join(snapshot, "file.txt"), "payload");
    const spec = {
      controlPath: session.controlPath,
      user: session.endpoint.user,
      host: session.endpoint.host,
      port: session.endpoint.port,
      privateKeyPath: path.join(fixture.root, "client"),
      knownHostsPath: session.knownHostsPath,
      hostKeyAlias: session.sandboxId,
      connectTimeoutSec: session.connectTimeoutSec,
    };
    const files = [{ path: "file.txt" }];
    const stalled = buildRsyncPushArgs(spec, snapshot, guestDir, files.map((f) => f.path));
    stalled.splice(1, 0, "--rsync-path=sleep 20; rsync");
    const start = Date.now();
    const result = await runStreamProcess("rsync", stalled.slice(1), {
      stdin: Readable.from([renderFilesFromList(files)]),
      timeoutMs: 1_000,
      killProcessGroup: true,
    });
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(result.timedOut).toBe(true);
    // Only the shared master may still reference the control path: the
    // push's own ssh client (rsync's transport) must be gone.
    const survivors = (await sshClientPids(session.controlPath)).filter((pid) => pid !== masterPid);
    expect(survivors).toEqual([]);

    const clean = buildRsyncPushArgs(spec, snapshot, guestDir, files.map((f) => f.path));
    const second = await runStreamProcess("rsync", clean.slice(1), {
      stdin: Readable.from([renderFilesFromList(files)]),
      timeoutMs: 10_000,
      killProcessGroup: true,
    });
    expect(second).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(path.join(guestDir, "file.txt"), "utf8")).toBe("payload");
    expect(existsSync(session.controlPath)).toBe(true);
  }, 30_000);
});
