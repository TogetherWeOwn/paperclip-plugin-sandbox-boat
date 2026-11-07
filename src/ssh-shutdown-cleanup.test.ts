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
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
import { isExecutorRefusal, type ExecutorRefusal } from "./offload/broker.js";

/** resolve() returns a reasoned refusal instead of bare null; narrow where a test needs the executor. */
function mustResolve(value: OffloadExecutor | ExecutorRefusal): OffloadExecutor {
  if (isExecutorRefusal(value)) throw new Error(`unexpected offload refusal: ${value.refusalReason}`);
  return value;
}

import { listAllFilesAsTracked, noInitializedSubmodules, noUntrackedFiles } from "./test-support/tracked-files.js";
import type { BackendCommand } from "./offload/broker.js";

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
      tunnelSpec: null, tunnelError: null, connectTimeoutSec: 2, lastMasterStartAt: 0, masterStarting: null, startingChild: null };
    (ssh as unknown as { sessions: Map<string, SshSession> }).sessions.set("vm-1", stub);
    // Default real clock: the drain budget is a real-time deadline, not the
    // injectable sleep, so a hanging drain holds shutdown for the budget and
    // then releases it. Never settles: shutdown must proceed anyway.
    const manager = new BoatVmManager({ state: harness.ctx.state, logger: harness.ctx.logger, ssh });
    (manager as unknown as { nativeOffload: { shutdown(): Promise<void> } }).nativeOffload.shutdown =
      () => new Promise<void>(() => {});
    const started = Date.now();
    await manager.shutdown();
    const elapsed = Date.now() - started;
    // Bounded by the budget (plus slack for a loaded CI box), and the budget
    // actually waited out rather than skipped by a fake clock.
    expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_DRAIN_TIMEOUT_MS - 1_000);
    expect(elapsed).toBeLessThan(SHUTDOWN_DRAIN_TIMEOUT_MS + 10_000);
    expect(ssh.getSession("vm-1")).toBeNull();
    expect(ssh.keyDirPath).toBeNull();
    expect(existsSync(keyDir)).toBe(false);
    await rm(stubDir, { recursive: true, force: true });
  }, 20_000);

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
      tunnelSpec: null, tunnelError: null, connectTimeoutSec: 2, lastMasterStartAt: 0, masterStarting: null, startingChild: null };
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
    // The fixture's host.pub carries an ssh-keygen comment; production
    // endpoints are exactly `<type> <base64>`, which openSession enforces.
    const endpoint = { ...session.endpoint, hostKey: session.endpoint.hostKey.split(" ").slice(0, 2).join(" ") };
    const opened = await manager.openSession({ sandboxId: "close-me-test", endpoint,
      tunnel: null, connectTimeoutSec: 2 });
    expect(manager.getSession("close-me-test")).not.toBeNull();
    expect(existsSync(opened.knownHostsPath)).toBe(true);
    await manager.closeSession("close-me-test");
    expect(manager.getSession("close-me-test")).toBeNull();
    expect(existsSync(opened.knownHostsPath)).toBe(false);
    expect(existsSync(opened.controlPath)).toBe(false);
  }, 30_000);
});

describe("closeSession with an in-flight master", () => {
  function connectingSession(sandboxId: string): SshSession {
    return { sandboxId, endpoint: { host: "127.0.0.1", port: 22, user: "u", hostKey: "k" },
      knownHostsPath: path.join(tmpdir(), `${sandboxId}-known-hosts`),
      controlPath: path.join(tmpdir(), `${sandboxId}.ctl`),
      master: null, tunnel: "disabled", tunnelSpec: null, tunnelError: null,
      connectTimeoutSec: 2, lastMasterStartAt: 0, masterStarting: null, startingChild: null };
  }

  it("kills a still-connecting master child", async () => {
    const manager = new SshManager({ info() {}, warn() {} });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const session = connectingSession("closing-while-connecting");
    session.startingChild = child;
    (manager as unknown as { sessions: Map<string, SshSession> }).sessions.set(session.sandboxId, session);
    await manager.closeSession(session.sandboxId);
    expect(manager.getSession(session.sandboxId)).toBeNull();
    expect(session.startingChild).toBeNull();
    await expect.poll(() => pidRunning(child.pid!), { timeout: 5_000 }).toBe(false);
  }, 15_000);

  it("startMaster does not spawn for an unregistered session", async () => {
    const manager = new SshManager({ info() {}, warn() {} });
    // Never registered: simulates a closeSession that won the race before
    // the starter ran. ensureKey runs (real ssh-keygen), then the liveness
    // guard returns before any ssh child is spawned.
    const session = connectingSession("already-closed");
    await (manager as unknown as { startMaster(session: SshSession): Promise<void> }).startMaster(session);
    expect(session.master).toBeNull();
    expect(session.startingChild).toBeNull();
    await manager.closeAll();
  }, 15_000);
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

  it("keeps a marked dir when owner liveness is uncertain", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "pcboat-sweep-test-"));
    try {
      const uncertain = path.join(base, "pcboat-uncertain");
      await mkdir(uncertain);
      await writeFile(path.join(uncertain, "id_ed25519"), "stale", { mode: 0o600 });
      const owner = await deadPid();
      await writeFile(path.join(uncertain, "owner.pid"), `${owner}\n`);
      // An unexpected kill error (neither ESRCH nor EPERM) proves nothing
      // about the owner: the dir must be kept, not reaped as dead.
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === owner) {
          const err = new Error("uncertain liveness") as NodeJS.ErrnoException;
          err.code = "EINVAL";
          throw err;
        }
        return realKill(pid, signal as 0);
      }) as typeof process.kill);
      try {
        const removed = await cleanupStaleKeyDirs(base);
        expect(removed).toEqual([]);
        expect(existsSync(uncertain)).toBe(true);
      } finally {
        kill.mockRestore();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps old unmarked dirs even when idle: idle is not dead", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "pcboat-sweep-test-"));
    try {
      const legacy = path.join(base, "pcboat-legacy-stale");
      await mkdir(legacy);
      await writeFile(path.join(legacy, "id_ed25519"), "stale", { mode: 0o600 });
      // Predates the owner.pid marker: backdate well past a day last, so
      // creating the contents does not refresh the mtime. A live
      // pre-upgrade worker between commands has no referencing ssh client,
      // so the sweep must still keep it — these leak until manual cleanup.
      const old = new Date(Date.now() - 25 * 3_600_000);
      await utimes(legacy, old, old);
      const removed = await cleanupStaleKeyDirs(base);
      expect(removed).toEqual([]);
      expect(existsSync(legacy)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps an old unmarked dir still referenced by a live ssh client", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "pcboat-sweep-test-"));
    // Stand-in for a pre-upgrade worker's live control master: a process
    // named ssh whose command line references the legacy dir. A shell script
    // keeps comm at its own basename (a copied node binary would rename its
    // thread to MainThread after startup and escape the sweep's filter).
    const bin = await mkdtemp(path.join(tmpdir(), "pcboat-fakessh-"));
    const fakeSsh = path.join(bin, "ssh");
    await writeFile(fakeSsh, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const legacy = path.join(base, "pcboat-legacy-live");
    await mkdir(legacy);
    const old = new Date(Date.now() - 25 * 3_600_000);
    await utimes(legacy, old, old);
    const watcher = spawn(fakeSsh, [legacy], { stdio: "ignore" });
    try {
      await expect.poll(async () => {
        try {
          return (await readFile(`/proc/${watcher.pid}/comm`, "utf8")).trim();
        } catch {
          return "";
        }
      }, { timeout: 5_000 }).toBe("ssh");
      const removed = await cleanupStaleKeyDirs(base);
      expect(removed).toEqual([]);
      expect(existsSync(legacy)).toBe(true);
    } finally {
      watcher.kill("SIGKILL");
      await once(watcher, "exit").catch(() => undefined);
      await rm(base, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
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
  async function setupRuntime(options: { realOpener?: boolean; ssh?: Record<string, unknown> } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "pcboat-rt-"));
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "Cargo.toml"), "public source");
    await writeFile(path.join(source, "Cargo.lock"), "local-lock");
    const harness = createFakeContext();
    const closeSession = vi.fn(async (_sandboxId: string) => {});
    const sshStub = { closeSession, ...options.ssh } as unknown as SshManager;
    const boat = new FakeBoat({ now: Date.now });
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: sshStub,
      accountId: "test-only", trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
      boat: () => boat as unknown as BoatApiLike,
      ...(options.realOpener ? {} : { session: async (sandboxId: string) => ({ sandboxId }) as SshSession }),
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
    const executor = mustResolve(await runtime.resolve(cmd("cmd-1"), settings));
    expect(boat.calls).toHaveLength(0);
    const pools = (runtime as unknown as { pools: Map<string, { sessions: Map<string, SshSession>;
      guest: { deps: { session(id: string): Promise<SshSession>; refreshSession(id: string): Promise<SshSession> } } }> }).pools;
    const entry = [...pools.values()][0]!;
    const hook = (executor as unknown as { onVmReleased: (sandboxId: string) => Promise<void> })
      .onVmReleased;
    return { runtime, root, boat, closeSession, entry, hook };
  }

  // The worker's drain is bounded, then it closes every session and the key
  // dir: an open still running past that point must not recreate the key,
  // authorize it on the VM or keep a new control master.
  it("shutdown fences the session opener after each step and refuses refreshes", async () => {
    const markClosing = (runtime: SshOffloadRuntime) => { (runtime as unknown as { closing: boolean }).closing = true; };
    const opened = (sandboxId: string) => ({ sandboxId }) as SshSession;
    // Shutdown begins while the key is being ensured: no authorization, no open.
    {
      let runtime!: SshOffloadRuntime;
      const openSession = vi.fn(async (input: { sandboxId: string }) => opened(input.sandboxId));
      const s = await setupRuntime({ realOpener: true, ssh: {
        ensureKey: vi.fn(async () => { markClosing(runtime); return { publicKey: "ssh-ed25519 AAAAKEY" }; }),
        openSession, run: vi.fn(async () => ({ exitCode: 0 })) } });
      runtime = s.runtime;
      try {
        const vm = String((await s.boat.create()).sandbox.id);
        await expect(s.entry.guest.deps.session(vm)).rejects.toMatchObject({ code: "OFFLOAD_RUNTIME_CLOSING" });
        expect(s.boat.calls.map((call) => call.method)).not.toContain("sshKey");
        expect(openSession).not.toHaveBeenCalled();
        expect(s.entry.sessions.has(vm)).toBe(false);
      } finally {
        await s.runtime.shutdown();
        await rm(s.root, { recursive: true, force: true });
      }
    }
    // Shutdown begins while the master opens: the new session is closed, not cached.
    {
      let runtime!: SshOffloadRuntime;
      const s = await setupRuntime({ realOpener: true, ssh: {
        ensureKey: vi.fn(async () => ({ publicKey: "ssh-ed25519 AAAAKEY" })),
        openSession: vi.fn(async (input: { sandboxId: string }) => { markClosing(runtime); return opened(input.sandboxId); }),
        run: vi.fn(async () => ({ exitCode: 0 })) } });
      runtime = s.runtime;
      try {
        const vm = String((await s.boat.create()).sandbox.id);
        await expect(s.entry.guest.deps.session(vm)).rejects.toMatchObject({ code: "OFFLOAD_RUNTIME_CLOSING" });
        expect(s.closeSession).toHaveBeenCalledWith(vm);
        expect(s.entry.sessions.has(vm)).toBe(false);
      } finally {
        await s.runtime.shutdown();
        await rm(s.root, { recursive: true, force: true });
      }
    }
    // After shutdown began, a refresh refuses before touching the key or the
    // cache, while an already-cached session stays usable for the drain.
    {
      const ensureKey = vi.fn(async () => ({ publicKey: "ssh-ed25519 AAAAKEY" }));
      const s = await setupRuntime({ realOpener: true, ssh: { ensureKey, openSession: vi.fn(), run: vi.fn() } });
      try {
        const cached = opened("vm-cached");
        s.entry.sessions.set("vm-cached", cached);
        markClosing(s.runtime);
        await expect(s.entry.guest.deps.refreshSession("vm-cached")).rejects.toMatchObject({ code: "OFFLOAD_RUNTIME_CLOSING" });
        await expect(s.entry.guest.deps.session("vm-new")).rejects.toMatchObject({ code: "OFFLOAD_RUNTIME_CLOSING" });
        await expect(s.entry.guest.deps.session("vm-cached")).resolves.toBe(cached);
        expect(ensureKey).not.toHaveBeenCalled();
      } finally {
        await s.runtime.shutdown();
        await rm(s.root, { recursive: true, force: true });
      }
    }
  }, 15_000);

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
