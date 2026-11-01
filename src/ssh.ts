// SSH to boat sandboxes, the documented way (docs.boat.dev/ssh-access and the
// POST /sandboxes/{id}/sshkey reference):
//   1. authorize our public key with POST /sandboxes/{id}/sshkey;
//   2. pin the host key from that API answer (it comes over the API, not over
//      SSH, so there is no trust-on-first-use);
//   3. connect to sshEndpoint ("host:port") when set, else machineIp:22, as
//      the answer's sshUser (boat's non-root `user`);
//   4. redo 1-3 after every resume or fork: the machine, IP and host key change.
// The reverse tunnel is the documented stock-OpenSSH form
// (`ssh -o ExitOnForwardFailure=yes -N -R <port>:127.0.0.1:<port> user@<ip>`),
// bound to 127.0.0.1 inside the sandbox only. It rides an OpenSSH control
// master, so each command reuses one connection instead of a new handshake.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cancelRemoteCommand, stripRunMarker, wrapRemoteCommand } from "./shell.js";

export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
  hostKey: string;
}

export interface TunnelSpec {
  remotePort: number;
  targetHost: string;
  targetPort: number;
}

export interface SshSession {
  sandboxId: string;
  endpoint: SshEndpoint;
  knownHostsPath: string;
  controlPath: string;
  master: ChildProcess | null;
  tunnel: "up" | "down" | "disabled";
  tunnelSpec: TunnelSpec | null;
  tunnelError: string | null;
  connectTimeoutSec: number;
  lastMasterStartAt: number;
}

export interface SshExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SshLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const SIGKILL_GRACE_MS = 250;
const MASTER_RESTART_MIN_INTERVAL_MS = 10_000;
const REMOTE_CANCEL_TIMEOUT_MS = 10_000;

/** Parse the POST /sandboxes/{id}/sshkey answer into a connect target. */
export function endpointFromSshKeyResponse(response: {
  machineIp?: string | null;
  sshEndpoint?: string | null;
  sshUser?: string;
  hostKey?: string;
}): SshEndpoint {
  const hostKey = (response.hostKey ?? "").trim();
  if (!hostKey) throw new Error("boat returned no SSH host key for the sandbox; cannot pin it.");
  const user = response.sshUser?.trim() || "user";
  const endpoint = response.sshEndpoint?.trim();
  if (endpoint) {
    const bracketed = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]), user, hostKey };
    const index = endpoint.lastIndexOf(":");
    if (index > 0) {
      const port = Number(endpoint.slice(index + 1));
      if (Number.isInteger(port) && port > 0) return { host: endpoint.slice(0, index), port, user, hostKey };
    }
    throw new Error(`boat returned an sshEndpoint that is not host:port: ${endpoint}`);
  }
  const ip = response.machineIp?.trim();
  if (!ip) throw new Error("boat returned neither sshEndpoint nor machineIp for the sandbox.");
  return { host: ip, port: 22, user, hostKey };
}

export class SshManager {
  private keyDir: string | null = null;
  private keyPromise: Promise<{ privateKeyPath: string; publicKey: string }> | null = null;
  private readonly sessions = new Map<string, SshSession>();

  private readonly pause: (ms: number) => Promise<void>;

  constructor(
    private readonly logger: SshLogger,
    pause?: (ms: number) => Promise<void>,
  ) {
    this.pause = pause ?? sleep;
  }

  /**
   * One ephemeral ed25519 key per worker process, made with ssh-keygen in a
   * 0700 temp dir. It is never stored in state or config; a restarted worker
   * makes a new key and authorizes it again through the API.
   */
  async ensureKey(): Promise<{ privateKeyPath: string; publicKey: string }> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const dir = await this.ensureDir();
        const privateKeyPath = path.join(dir, "id_ed25519");
        const result = await runProcess("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "paperclip-boat", "-f", privateKeyPath], {
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(`ssh-keygen failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
        }
        const publicKey = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
        return { privateKeyPath, publicKey };
      })().catch((error) => {
        this.keyPromise = null;
        throw error;
      });
    }
    return this.keyPromise;
  }

  private async ensureDir(): Promise<string> {
    if (!this.keyDir) {
      this.keyDir = await mkdtemp(path.join(tmpdir(), "pcboat-"));
    }
    return this.keyDir;
  }

  getSession(sandboxId: string): SshSession | null {
    return this.sessions.get(sandboxId) ?? null;
  }

  listSessions(): SshSession[] {
    return [...this.sessions.values()];
  }

  async openSession(input: {
    sandboxId: string;
    endpoint: SshEndpoint;
    tunnel: TunnelSpec | null;
    connectTimeoutSec: number;
  }): Promise<SshSession> {
    await this.closeSession(input.sandboxId);
    const dir = await this.ensureDir();
    const safeId = input.sandboxId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
    const knownHostsPath = path.join(dir, `known_hosts_${safeId}`);
    // HostKeyAlias = sandbox id, the pattern in docs.boat.dev/ssh-access.
    await writeFile(knownHostsPath, `${input.sandboxId} ${input.endpoint.hostKey}\n`, { mode: 0o600 });
    const session: SshSession = {
      sandboxId: input.sandboxId,
      endpoint: input.endpoint,
      knownHostsPath,
      controlPath: path.join(dir, `${safeId}.ctl`),
      master: null,
      tunnel: input.tunnel ? "down" : "disabled",
      tunnelSpec: input.tunnel,
      tunnelError: null,
      connectTimeoutSec: input.connectTimeoutSec,
      lastMasterStartAt: 0,
    };
    this.sessions.set(input.sandboxId, session);
    await this.startMaster(session);
    return session;
  }

  masterAlive(session: SshSession): boolean {
    return !!session.master && session.master.exitCode === null && session.master.signalCode === null && !session.master.killed;
  }

  /** Restart a dead control master (and its tunnel) at most every 10 s. */
  async ensureMaster(session: SshSession): Promise<void> {
    if (this.masterAlive(session)) return;
    if (Date.now() - session.lastMasterStartAt < MASTER_RESTART_MIN_INTERVAL_MS) return;
    await this.startMaster(session);
  }

  private async startMaster(session: SshSession): Promise<void> {
    const key = await this.ensureKey();
    session.lastMasterStartAt = Date.now();
    const attempts: Array<TunnelSpec | null> = session.tunnelSpec ? [session.tunnelSpec, session.tunnelSpec, null] : [null];
    for (const tunnel of attempts) {
      const args = [
        "-N",
        "-o",
        "ControlMaster=yes",
        "-o",
        `ControlPath=${session.controlPath}`,
        "-o",
        "ControlPersist=no",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        ...(tunnel
          ? ["-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${tunnel.remotePort}:${tunnel.targetHost}:${tunnel.targetPort}`]
          : []),
        ...commonSshOptions(session, key.privateKeyPath),
        `${session.endpoint.user}@${session.endpoint.host}`,
      ];
      const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const ready = await waitForControlSocket(child, session.controlPath, (session.connectTimeoutSec + 5) * 1000);
      if (ready) {
        session.master = child;
        session.tunnel = tunnel ? "up" : session.tunnelSpec ? "down" : "disabled";
        if (!tunnel && session.tunnelSpec) {
          this.logger.warn("boat: reverse tunnel could not be opened; commands still run", {
            sandboxId: session.sandboxId,
            reason: session.tunnelError,
          });
        }
        child.once("exit", () => {
          if (session.master === child) {
            session.master = null;
            if (session.tunnel === "up") session.tunnel = "down";
          }
        });
        return;
      }
      killQuietly(child);
      session.tunnelError = stderr.trim().slice(0, 500) || "control master did not start";
      if (tunnel) await this.pause(2_000);
    }
    // No master: commands fall back to one direct connection each.
    session.master = null;
    if (session.tunnelSpec) session.tunnel = "down";
    this.logger.warn("boat: SSH control master did not start; falling back to direct connections", {
      sandboxId: session.sandboxId,
      reason: session.tunnelError,
    });
  }

  async run(
    session: SshSession,
    remoteCommand: string,
    options: { stdin?: string; timeoutMs: number; maxOutputBytes?: number },
  ): Promise<SshExecutionResult> {
    // Same supervised path as runStream: an unsupervised multiplexed slave
    // never ends on timeout, because killing the local ssh client leaves the
    // master holding the channel until the remote job exits on its own. The
    // supervisor wrap + bounded cancel in runSupervised make timeoutMs real
    // for execute, scrub, prepareRemote and env staging alike. Output stays
    // uncapped unless the caller bounds it, matching run()'s prior contract
    // (whole-run execute returns the command's full stdout to the host).
    return await this.runSupervised(session, remoteCommand, {
      stdin: options.stdin != null ? Readable.from([options.stdin]) : undefined,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? null,
      // run()'s old contract: a command that exits without reading its stdin
      // (or an ssh that never connects) reports its own status — 3, or 255 —
      // never a thrown EPIPE that would bypass callers' status handling.
      tolerateStdinClose: true,
    }, false);
  }

  /** Binary transport over the same pinned connection; run() remains control-only. */
  async runStream(session: SshSession, remoteCommand: string, options: StreamProcessOptions): Promise<SshExecutionResult> {
    return await this.runSupervised(session, remoteCommand, options);
  }

  private async runSupervised(
    session: SshSession,
    remoteCommand: string,
    options: StreamProcessOptions,
    // runStream's binary callers treat a failed remote cleanup as a failed
    // transfer. run() callers expect a result object (exit code, timedOut)
    // and branch on it — execute, env staging and the scrub status mapping
    // would all be bypassed by a cleanup throw — so run() logs and returns.
    cleanupFailureThrows = true,
  ): Promise<SshExecutionResult> {
    const key = await this.ensureKey();
    const slave = (command: string) => [
      "-T", "-o", `ControlPath=${session.controlPath}`, "-o", "ControlMaster=no",
      ...commonSshOptions(session, key.privateKeyPath),
      `${session.endpoint.user}@${session.endpoint.host}`, command,
    ];
    // The caller knows this identity BEFORE submitting work. Neither admission
    // revocation nor group cancellation depends on receiving a stderr marker.
    const runId = randomUUID().replace(/-/g, "");
    let result: SshExecutionResult | undefined;
    try {
      result = await runStreamProcess("ssh", slave(wrapRemoteCommand(remoteCommand, runId, true)), options);
      return { ...result, stderr: stripRunMarker(result.stderr, runId) };
    } finally {
      // Local pipe/cap errors throw, while timeouts return a result. Both must
      // finish bounded remote cleanup BEFORE releasing activity/rejecting. On
      // success this also removes the registration and any background children.
      // Never signal the shared master, and never replace the original failure.
      try {
        const cleanup = await runStreamProcess("ssh", slave(cancelRemoteCommand(runId)), { timeoutMs: REMOTE_CANCEL_TIMEOUT_MS });
        if (cleanup.timedOut || cleanup.exitCode !== 0) {
          throw new Error(`Remote command cleanup failed: ${cleanup.stderr.trim() || "timeout or nonzero exit"}`);
        }
      } catch (error) {
        this.logger.warn("boat: remote command cleanup failed; remote work may still be running", {
          sandboxId: session.sandboxId, reason: (error as Error).message,
        });
        if (cleanupFailureThrows && result && !result.timedOut && result.exitCode === 0) throw error;
      }
    }
  }

  async closeSession(sandboxId: string): Promise<void> {
    const session = this.sessions.get(sandboxId);
    if (!session) return;
    this.sessions.delete(sandboxId);
    if (session.master) killQuietly(session.master);
    session.master = null;
    await rm(session.knownHostsPath, { force: true }).catch(() => undefined);
    await rm(session.controlPath, { force: true }).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const sandboxId of [...this.sessions.keys()]) await this.closeSession(sandboxId);
    if (this.keyDir) await rm(this.keyDir, { recursive: true, force: true }).catch(() => undefined);
    this.keyDir = null;
    this.keyPromise = null;
  }
}

function commonSshOptions(session: SshSession, privateKeyPath: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${session.knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${session.sandboxId}`,
    "-o",
    "CheckHostIP=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    `ConnectTimeout=${session.connectTimeoutSec}`,
    "-o",
    "LogLevel=ERROR",
    "-i",
    privateKeyPath,
    "-p",
    String(session.endpoint.port),
  ];
}

async function waitForControlSocket(child: ChildProcess, controlPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (existsSync(controlPath)) return true;
    await sleep(100);
  }
  return false;
}

function killQuietly(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StreamProcessOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** Control-output cap per stream. `null` collects without a cap (run() only). */
  maxOutputBytes?: number | null;
  timeoutMs: number;
  /** Fixed working directory and environment instead of inheriting the worker's. */
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Spawn in its own process group and signal the whole group on abort.
   * For children that fork their own transport (rsync spawns ssh): killing
   * only the parent orphans the transport, which keeps the inherited stderr
   * pipe — and the remote channel — open past the timeout.
   */
  killProcessGroup?: boolean;
  /**
   * An early-closed child stdin is not a failure: the child's own status is
   * the result. Only for in-memory stdin (run()'s string), whose source
   * cannot fail on its own; binary callers keep stdin delivery strict.
   */
  tolerateStdinClose?: boolean;
}

/** Backpressured binary IO, bounded control output, and cleanup on either pipe's failure. */
export async function runStreamProcess(command: string, args: string[], options: StreamProcessOptions): Promise<SshExecutionResult> {
  const cap = options.maxOutputBytes === null ? Number.POSITIVE_INFINITY : (options.maxOutputBytes ?? 256 * 1024);
  if ((cap !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(cap) || cap < 0)) || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Invalid streaming process limits.");
  }
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: options.killProcessGroup === true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  let failure: Error | undefined;
  let timedOut = false;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let signalled = false;
  let exited: { code: number | null; signal: string | null } | undefined;
  let finishCompletion: (result: { code: number | null; signal: string | null }) => void = () => undefined;
  const groupAlive = (): boolean => {
    if (!options.killProcessGroup || child.pid == null) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const signalChild = (signal: NodeJS.Signals) => {
    if (options.killProcessGroup && child.pid != null) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Group already gone (or never formed): fall back to the child.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  const abort = (error: Error) => {
    failure ??= error;
    options.stdin?.destroy(error);
    child.stdin.destroy(error);
    child.stdout.destroy(error);
    options.stdout?.destroy(error);
    // Signal the child exactly once: the timer plus one failing pipe per
    // stdio endpoint can invoke abort several times in the same tick, and a
    // burst of SIGTERMs down the relay/supervisor chain kills the remote
    // payload before its own SIGTERM cleanup (staging-scratch unlink) runs.
    if (!closed && !signalled) {
      signalled = true;
      signalChild("SIGTERM");
      killTimer ??= setTimeout(() => signalChild("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref?.();
      // Last resort: a grandchild can hold a stdio pipe after the child is
      // dead, so 'close' may never fire. Once SIGKILL has had its grace,
      // detach both streams and settle with whatever exit we observed
      // instead of waiting for the remote side to let go.
      forceTimer ??= setTimeout(() => {
        child.stdout.destroy();
        detachStderr();
        finishCompletion(exited ?? { code: null, signal: null });
      }, SIGKILL_GRACE_MS * 2);
    }
  };
  // A multiplexed ssh slave's stderr stays open until its remote job ends,
  // which outlives the signalled slave itself. Once the slave exits, detach
  // stderr from its pipeline without an error: already-buffered bytes (the
  // cancellation marker) survive, the collector ends cleanly, and close —
  // which only needs the exit plus drained stdio — resolves promptly.
  // The same holds for any aborted child whose grandchildren inherit the
  // stderr pipe (rsync's ssh transport): detach on exit whenever we are
  // aborting, not only for ssh itself. A clean, normally-exiting non-ssh
  // child keeps its stderr until EOF so trailing diagnostics survive.
  let stderrDetached = false;
  const detachStderr = () => {
    if (stderrDetached) return;
    stderrDetached = true;
    child.stderr.unpipe();
    child.stderr.destroy();
  };
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    if (command === "ssh" || timedOut || failure !== undefined) detachStderr();
    if (timedOut || failure !== undefined) child.stdout.destroy();
  });
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    let settled = false;
    finishCompletion = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => abort(error));
    child.once("close", (code, signal) => {
      closed = true;
      // The direct child's close does not prove its process group is empty:
      // a SIGTERM-ignoring descendant must still receive the SIGKILL
      // escalation. Keep the bounded timer (unref'd) while the group lives.
      if (killTimer && !(options.killProcessGroup && signalled && groupAlive())) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      finishCompletion({ code, signal });
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    abort(new Error("Streaming process timed out."));
  }, options.timeoutMs);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  function collector(chunks: Buffer[]): Writable {
    let bytes = 0;
    return new Writable({ write(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > cap) done(new Error("Streaming process control output exceeds its byte limit."));
      else { chunks.push(Buffer.from(chunk)); done(); }
    } });
  }
  // Observe every pipe immediately: waiting for exit first deadlocks a full pipe.
  const stdinPipe = pipeline(options.stdin ?? Readable.from([]), child.stdin);
  const pipes = [
    pipeline(child.stdout, options.stdout ?? collector(stdout)),
    // The detach destroys stderr before its EOF whenever the slave exits
    // first; that premature close is ours, not a stream failure.
    pipeline(child.stderr, collector(stderr)).catch((error: NodeJS.ErrnoException) => {
      if (!stderrDetached || error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    }),
    // With tolerateStdinClose, an EPIPE here just means the child stopped
    // reading (it exited, or ssh never connected): its status is the result.
    options.tolerateStdinClose ? stdinPipe.catch(() => undefined) : stdinPipe,
  ];
  for (const pipe of pipes) void pipe.catch((error: Error) => abort(error));
  try {
    const result = await completion;
    await Promise.allSettled(pipes);
    if (failure && !timedOut) throw failure;
    return { exitCode: timedOut ? null : result.code, signal: result.signal, timedOut,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timer);
    // Same rule as the close handler: never cancel a pending group SIGKILL
    // while the group is still alive; the timer is unref'd and one-shot.
    if (killTimer && !(options.killProcessGroup && signalled && groupAlive())) clearTimeout(killTimer);
    if (forceTimer) clearTimeout(forceTimer);
  }
}

/** Spawn a process, collect output, enforce a timeout. Secrets go through stdin only, never argv. */
export async function runProcess(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<SshExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"] });
    // Collect raw bytes and decode once at the end: decoding each chunk on
    // its own corrupts a multi-byte UTF-8 sequence split across pipe reads.
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let killTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
            // 'close' waits for stdio EOF, which a grandchild inheriting the
            // pipes (or a multiplexed channel the master still holds) can
            // postpone indefinitely. After SIGKILL's grace, settle without it.
            forceTimer = setTimeout(() => finish(exited?.code ?? null, exited?.signal ?? null), SIGKILL_GRACE_MS * 2);
          }, options.timeoutMs)
        : null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      // The child is dead; only inherited pipes can still hold 'close' back.
      // Give buffered output one grace period to drain, then settle on the
      // exit we already have instead of waiting for someone else's EOF.
      forceTimer ??= setTimeout(() => finish(code, signal), SIGKILL_GRACE_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
    if (options.stdin != null && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
