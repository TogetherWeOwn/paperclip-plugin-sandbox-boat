// B10: process and tunnel leaks.
// - Worker shutdown reaches ssh.closeAll within the drain budget, even when
//   the offload drain hangs or rejects (masters, tunnel and /tmp key dir).
// - Concurrent ensureMaster calls share one starter (loopback sshd).
// - closeSession removes the session's known_hosts and control socket.
// - Offload idle stops release the SSH session through onVmReleased.
// - Stale pcboat-* key dirs are swept at startup by owner liveness.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
// MemAccountState, not the admission fixture: the fixture's vi.mock on
// node:child_process would stub spawn for this whole file, and these tests
// need real processes (ssh-keygen, sshd, pgrep).
import { MemAccountState } from "./test-support/durable-offload.js";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { OffloadExecutor } from "./offload.js";
import type { BoatApiLike } from "./boat-client.js";
import type { OffloadCommand, OffloadDeps, OffloadResult } from "./offload.js";
import { SshManager, cleanupStaleKeyDirs } from "./ssh.js";
import type { SshSession } from "./ssh.js";
import { BoatVmManager, SHUTDOWN_DRAIN_TIMEOUT_MS } from "./vm-manager.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { listAllFilesAsTracked } from "./test-support/tracked-files.js";
import type { BackendCommand } from "./offload/broker.js";

const execFileAsync = promisify(execFile);

function pidRunning(pid: number): boolean {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[1] !== "Z";
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

async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid!;
  child.kill("SIGKILL");
  await once(child, "exit");
  return pid;
}

describe("manager shutdown reaches ssh.closeAll", () => {
  it("the drain budget is at most 5 s", () => {
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("a never-settling offload drain still closes sessions and removes the key dir", async () => {
    const harness = createFakeContext();
    const ssh = new SshManager(harness.ctx.logger);
    await ssh.ensureKey();
    const keyDir = ssh.keyDirPath!;
    const stubDir = await mkdtemp(path.join(tmpdir(), "pcboat-stub-"));
    const knownHostsPath = path.join(stubDir, "known_hosts_stub");
    await writeFile(knownHostsPath, "stub");
    const stub: SshSession = { sandboxId: "vm-1", endpoint: { host: "127.0.0.1", port: 22, user: "u", hostKey: "k" },
      knownHostsPath, controlPath: path.join(stubDir, "vm-1.ctl"), master: null, tunnel: "disabled",
      tunnelSpec: null, tunnelError: null, connectTimeoutSec: 2, lastMasterStartAt: 0, masterStarting: null };
    (ssh as unknown as { sessions: Map<string, SshSession> }).sessions.set("vm-1", stub);
    let releaseSleep!: () => void;
    const manager = new BoatVmManager({ state: harness.ctx.state, logger: harness.ctx.logger, ssh,
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve; }) });
    // Never settles: shutdown must proceed once the drain budget fires.
    (manager as unknown as { nativeOffload: { shutdown(): Promise<void> } }).nativeOffload.shutdown =
      () => new Promise<void>(() => {});
    const shutdown = manager.shutdown();
    await Promise.resolve();
    // Still draining: sessions untouched.
    expect(ssh.getSession("vm-1")).not.toBeNull();
    releaseSleep();
    await shutdown;
    expect(ssh.getSession("vm-1")).toBeNull();
    expect(ssh.keyDirPath).toBeNull();
    expect(existsSync(keyDir)).toBe(false);
    await rm(stubDir, { recursive: true, force: true });
  }, 15_000);

  it("a rejecting offload drain still closes sessions and removes the key dir", async () => {
    const harness = createFakeContext();
    const ssh = new SshManager(harness.ctx.logger);
    await ssh.ensureKey();
    const keyDir = ssh.keyDirPath!;
    const stubDir = await mkdtemp(path.join(tmpdir(), "pcboat-stub-"));
    const knownHostsPath = path.join(stubDir, "known_hosts_stub");
    await writeFile(knownHostsPath, "stub");
    const stub: SshSession = { sandboxId: "vm-2", endpoint: { host: "127.0.0.1", port: 22, user: "u", hostKey: "k" },
      knownHostsPath, controlPath: path.join(stubDir, "vm-2.ctl"), master: null, tunnel: "disabled",
      tunnelSpec: null, tunnelError: null, connectTimeoutSec: 2, lastMasterStartAt: 0, masterStarting: null };
    (ssh as unknown as { sessions: Map<string, SshSession> }).sessions.set("vm-2", stub);
    const manager = new BoatVmManager({ state: harness.ctx.state, logger: harness.ctx.logger, ssh,
      sleep: () => new Promise<void>(() => {}) });
    (manager as unknown as { nativeOffload: { shutdown(): Promise<void> } }).nativeOffload.shutdown =
      async () => { throw new Error("drain boom"); };
    await manager.shutdown();
    expect(ssh.getSession("vm-2")).toBeNull();
    expect(ssh.keyDirPath).toBeNull();
    expect(existsSync(keyDir)).toBe(false);
    await rm(stubDir, { recursive: true, force: true });
  }, 15_000);
});

describe("ensureMaster single-flight (loopback sshd)", () => {
  let fixture: LoopbackSsh;
  beforeEach(async () => { fixture = new LoopbackSsh(); await fixture.start(); });
  afterEach(async () => { await fixture?.cleanup(); });

  it("three concurrent ensureMaster calls leave exactly one ssh -N, none after closeSession", async () => {
    const { manager, session } = fixture;
    // The fixture hand-rolls its session instead of openSession, so it is
    // not registered; register it like openSession would, or the winner
    // check (which refuses to resurrect a closed session's master) drops it.
    (manager as unknown as { sessions: Map<string, SshSession> }).sessions.set(session.sandboxId, session);
    session.master!.kill("SIGKILL");
    await expect.poll(() => pidRunning(session.master!.pid!), { timeout: 5_000 }).toBe(false);
    await rm(session.controlPath, { force: true });
    session.lastMasterStartAt = 0;
    await Promise.all([manager.ensureMaster(session), manager.ensureMaster(session), manager.ensureMaster(session)]);
    expect(manager.masterAlive(session)).toBe(true);
    expect(await sshClientPids(session.controlPath)).toHaveLength(1);
    const controlPath = session.controlPath;
    await manager.closeSession(session.sandboxId);
    expect(manager.getSession(session.sandboxId)).toBeNull();
    await expect.poll(() => sshClientPids(controlPath), { timeout: 5_000 }).toEqual([]);
  }, 30_000);

  it("closeSession removes known_hosts and the control socket", async () => {
    const { manager, session } = fixture;
    const opened = await manager.openSession({ sandboxId: "close-me-test", endpoint: session.endpoint,
      tunnel: null, connectTimeoutSec: 2 });
    expect(manager.getSession("close-me-test")).not.toBeNull();
    expect(existsSync(opened.knownHostsPath)).toBe(true);
    await manager.closeSession("close-me-test");
    expect(manager.getSession("close-me-test")).toBeNull();
    expect(existsSync(opened.knownHostsPath)).toBe(false);
    expect(existsSync(opened.controlPath)).toBe(false);
  }, 30_000);
});

describe("cleanupStaleKeyDirs", () => {
  it("removes dead-owner dirs and keeps live-owned and fresh unmarked dirs", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "pcboat-sweep-test-"));
    try {
      const dead = path.join(base, "pcboat-dead");
      const live = path.join(base, "pcboat-live");
      const fresh = path.join(base, "pcboat-fresh");
      const other = path.join(base, "other-dir");
      for (const dir of [dead, live, fresh, other]) await mkdir(dir);
      await writeFile(path.join(dead, "id_ed25519"), "stale", { mode: 0o600 });
      await writeFile(path.join(dead, "owner.pid"), `${await deadPid()}\n`);
      await writeFile(path.join(live, "owner.pid"), `${process.pid}\n`);
      const removed = await cleanupStaleKeyDirs(base);
      expect(removed).toEqual([dead]);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("ensureDir links the key dir to its creator pid", async () => {
    const ssh = new SshManager({ info() {}, warn() {} });
    await ssh.ensureKey();
    try {
      expect(ssh.keyDirPath).not.toBeNull();
      await expect(readFile(path.join(ssh.keyDirPath!, "owner.pid"), "utf8")).resolves.toBe(`${process.pid}\n`);
    } finally {
      await ssh.closeAll();
    }
  });
});

// Executor-level setup mirroring offload-stop-failure.test.ts: FakeBoat,
// manual timers, no guest or journal.
const EPOCH = Date.parse("2026-10-23T10:00:00Z");

function setupExecutor(onVmReleased?: OffloadDeps["onVmReleased"]) {
  const account = { state: new MemAccountState(), accountId: "ssh-cleanup-account", poolId: "ssh-cleanup-pool" };
  const clock = { t: EPOCH };
  const now = () => clock.t;
  const fake = new FakeBoat({ now });
  const timers = new Map<number, { at: number; cb: () => void }>();
  let serial = 0;
  const set = (cb: () => void, ms: number) => {
    const id = ++serial;
    timers.set(id, { at: clock.t + ms, cb });
    return id;
  };
  const clear = (handle: unknown) => { timers.delete(handle as number); };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    const target = clock.t + ms;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      clock.t = next[1].at;
      next[1].cb();
      await flush();
    }
    clock.t = target;
    await flush();
  };
  const starts: Array<{ sandboxId: string; commandId: string }> = [];
  const executor = new OffloadExecutor({
    ...account,
    boat: fake as unknown as BoatApiLike,
    logger: { info() {}, warn() {}, error() {} },
    now,
    timers: { set, clear },
    config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0 },
    onVmReleased,
    runCommand: async (sandboxId, cmd) => {
      starts.push({ sandboxId, commandId: cmd.commandId });
      return { exitCode: 0, seconds: 1 };
    },
  });
  const command = (commandId: string): OffloadCommand =>
    ({ commandId, companyId: "company-1", runId: "run-1", cardId: "card-1",
      repoId: "repo-1", profileId: "rust-secret-free", argv: ["test"] });
  return { executor, clock, fake, advance, starts, command,
    pool: () => (executor as unknown as { pool: Array<{ sandboxId: string; stopped: boolean }> }).pool };
}

describe("offload idle stop releases the SSH session", () => {
  it("calls onVmReleased with the pool VM id after an idle stop", async () => {
    const released: string[] = [];
    const s = setupExecutor((sandboxId) => { released.push(sandboxId); });
    const receipt = await s.executor.execute(s.command("cmd-1"));
    expect(receipt.status).toBe("completed");
    const sandboxId = s.starts[0]!.sandboxId;
    expect(released).toEqual([]);
    await s.advance(16_000);
    expect(released).toEqual([sandboxId]);
    expect(s.pool().find((vm) => vm.sandboxId === sandboxId)?.stopped).toBe(true);
  }, 15_000);

  it("a throwing hook does not fail the idle stop", async () => {
    const s = setupExecutor(() => { throw new Error("hook boom"); });
    await s.executor.execute(s.command("cmd-1"));
    const sandboxId = s.starts[0]!.sandboxId;
    await s.advance(16_000);
    expect(s.pool().find((vm) => vm.sandboxId === sandboxId)?.stopped).toBe(true);
    expect(s.fake.callsOf("stop").length).toBeGreaterThan(0);
  }, 15_000);

  it("completes a result whose hook rejects asynchronously", async () => {
    const s = setupExecutor(async () => { throw new Error("async hook boom"); });
    const receipt: OffloadResult = await s.executor.execute(s.command("cmd-1"));
    expect(receipt.status).toBe("completed");
    await s.advance(16_000);
    expect(s.pool().find((vm) => vm.sandboxId === s.starts[0]!.sandboxId)?.stopped).toBe(true);
  }, 15_000);
});

// Runtime-level wiring: resolve installs an onVmReleased that closes and
// forgets the cached session, and runtime shutdown closes leftovers. No
// guest execution, no cgroup: resolve only admits, and the fake session seam
// means no VM is ever reserved (boat.calls stays empty).
describe("runtime release-hook wiring (no guest)", () => {
  async function setupRuntime() {
    const root = await mkdtemp(path.join(tmpdir(), "pcboat-rt-"));
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "Cargo.toml"), "public source");
    await writeFile(path.join(source, "Cargo.lock"), "local-lock");
    const harness = createFakeContext();
    const closeSession = vi.fn(async (_sandboxId: string) => {});
    const sshStub = { closeSession } as unknown as SshManager;
    const boat = new FakeBoat({ now: Date.now });
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: sshStub,
      accountId: "test-only", trackedFiles: listAllFilesAsTracked,
      boat: () => boat as unknown as BoatApiLike,
      session: async (sandboxId: string) => ({ sandboxId }) as SshSession,
      guestOptions: { stateRoot: root } });
    const companyId = randomUUID(), runId = randomUUID(), executionWorkspaceId = randomUUID();
    runtime.remember({ driverKey: "boat", companyId, environmentId: "env",
      config: { apiKey: "test-only", maxOffloadVms: 1, offloadIdleStopSeconds: 1 },
      lease: { providerLeaseId: null },
      workspace: { localPath: source, metadata: { workspaceRealizationRequest: { version: 1, companyId,
        environmentId: "env", heartbeatRunId: runId, executionWorkspaceId,
        source: { localPath: source, repoUrl: "https://github.com/example/public", projectId: "project",
          projectWorkspaceId: null } } } } });
    const settings = { offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
      offloadCgroupParent: "/sys/fs/cgroup/test", offloadArtifactRoot: path.join(root, "artifacts"),
      offloadAllowedRepos: ["repo:https://github.com/example/public"] };
    const cmd = (commandId: string): BackendCommand => ({ companyId, runId, executionWorkspaceId, commandId,
      cardId: "card", repoId: "repo:https://github.com/example/public", profileId: "rust-public-1",
      argv: ["test", "--locked"], cwdRelative: ".", env: {}, timeoutMs: 10_000, queueTimeoutMs: 0 });
    const executor = await runtime.resolve(cmd("cmd-1"), settings);
    expect(executor).not.toBeNull();
    expect(boat.calls).toHaveLength(0);
    const pools = (runtime as unknown as { pools: Map<string, { sessions: Map<string, SshSession> }> }).pools;
    const entry = [...pools.values()][0]!;
    const hook = (executor as unknown as { onVmReleased: (sandboxId: string) => Promise<void> })
      .onVmReleased;
    return { runtime, root, boat, closeSession, entry, hook };
  }

  it("the installed hook closes and forgets the cached session", async () => {
    const s = await setupRuntime();
    try {
      s.entry.sessions.set("vm-1", { sandboxId: "vm-1" } as SshSession);
      await s.hook("vm-1");
      expect(s.entry.sessions.has("vm-1")).toBe(false);
      expect(s.closeSession).toHaveBeenCalledWith("vm-1");
    } finally {
      await s.runtime.shutdown();
      await rm(s.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("runtime shutdown closes a leftover cached session", async () => {
    const s = await setupRuntime();
    try {
      s.entry.sessions.set("vm-left", { sandboxId: "vm-left" } as SshSession);
      await s.runtime.shutdown();
      expect(s.entry.sessions.has("vm-left")).toBe(false);
      expect(s.closeSession).toHaveBeenCalledWith("vm-left");
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  }, 15_000);
});
