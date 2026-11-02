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
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cancelRemoteCommand, finalizeRemoteCommand, stripRunMarker, wrapRemoteCommand } from "./shell.js";

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
  /** In-flight startMaster shared by concurrent ensureMaster callers. */
  masterStarting: Promise<void> | null;
  /** Control-master child still connecting (not yet stored in master). */
  startingChild: ChildProcess | null;
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

// Provider data is untrusted input to host processes: the sandbox id becomes
// the HostKeyAlias (a space-joined rsync -e word and a known_hosts pattern),
// the host key is written verbatim into known_hosts, and user@host is ssh's
// destination word, where a leading '-' is parsed as an option. These checks
// run where provider data becomes an SSH target — the sshkey answer parse and
// every openSession — so a malformed or hostile value throws before any ssh
// or rsync process spawns, whatever state it was read back from.
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SSH_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY_PATTERN = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|rsa-sha2-(?:256|512)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Throw unless a provider-supplied sandbox id is safe in every SSH context. */
export function assertValidSandboxId(sandboxId: string): string {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) {
    throw new Error(`boat returned a sandbox id that is not [A-Za-z0-9_-]{1,64}: ${JSON.stringify(sandboxId)}`);
  }
  return sandboxId;
}

/** An IP literal or an RFC 1123 hostname; never an option-looking word. */
export function isValidSshHost(host: string): boolean {
  return isIP(host) !== 0 || HOSTNAME_PATTERN.test(host);
}

/** Throw unless every field of a connect target is safe to hand to ssh. */
export function assertValidSshEndpoint(endpoint: SshEndpoint): SshEndpoint {
  if (!HOST_KEY_PATTERN.test(endpoint.hostKey)) {
    throw new Error("boat returned an SSH host key that is not a single `<type> <base64>` line; cannot pin it.");
  }
  if (!SSH_USER_PATTERN.test(endpoint.user)) {
    throw new Error(`boat returned an sshUser that is not a plain login name: ${JSON.stringify(endpoint.user)}`);
  }
  if (!isValidSshHost(endpoint.host)) {
    throw new Error(`boat returned an SSH host that is not an IP address or hostname: ${JSON.stringify(endpoint.host)}`);
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error(`boat returned an SSH port outside 1-65535: ${endpoint.port}`);
  }
  return endpoint;
}

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
    if (bracketed) return assertValidSshEndpoint({ host: bracketed[1], port: Number(bracketed[2]), user, hostKey });
    const index = endpoint.lastIndexOf(":");
    if (index > 0) {
      const port = Number(endpoint.slice(index + 1));
      if (Number.isInteger(port) && port > 0) return assertValidSshEndpoint({ host: endpoint.slice(0, index), port, user, hostKey });
    }
    throw new Error(`boat returned an sshEndpoint that is not host:port: ${endpoint}`);
  }
  const ip = response.machineIp?.trim();
  if (!ip) throw new Error("boat returned neither sshEndpoint nor machineIp for the sandbox.");
  return assertValidSshEndpoint({ host: ip, port: 22, user, hostKey });
}

export class SshManager {
  private keyDir: string | null = null;
  private keyPromise: Promise<{ privateKeyPath: string; publicKey: string }> | null = null;
  private readonly sessions = new Map<string, SshSession>();

  private readonly pause: (ms: number) => Promise<void>;

  // Guest-side directory for the run-cancellation records. Production keeps
  // the default (guest /tmp); test harnesses that execute the "remote"
  // scripts on this host pin it inside their own temp root so tombstones
  // from cancelled-before-admission runs cannot leak into host /tmp.
  private readonly runRecordDir?: string;

  constructor(
    private readonly logger: SshLogger,
    pause?: (ms: number) => Promise<void>,
    opts?: { runRecordDir?: string },
  ) {
    this.pause = pause ?? sleep;
    this.runRecordDir = opts?.runRecordDir;
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
      // Reap key dirs of dead workers before creating ours, so a crash loop
      // cannot accumulate key material and control sockets in /tmp. Best
      // effort: our own startup never fails because the sweep did.
      await cleanupStaleKeyDirs(tmpdir()).catch(() => undefined);
      this.keyDir = await mkdtemp(path.join(tmpdir(), "pcboat-"));
      // Owner marker for the startup sweep: same-uid processes may share the
      // key dir (uid is the boundary), so liveness is tracked by pid, and a
      // dir is only reaped once its creator is gone.
      await writeFile(path.join(this.keyDir, "owner.pid"), `${process.pid}\n`, { mode: 0o600 });
    }
    return this.keyDir;
  }

  get keyDirPath(): string | null {
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
    // Validate before touching any existing session or writing known_hosts:
    // endpoints can also arrive from persisted state, not only the parse above.
    assertValidSandboxId(input.sandboxId);
    assertValidSshEndpoint(input.endpoint);
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
      masterStarting: null,
      startingChild: null,
    };
    this.sessions.set(input.sandboxId, session);
    await this.startMaster(session);
    return session;
  }

  masterAlive(session: SshSession): boolean {
    return !!session.master && session.master.exitCode === null && session.master.signalCode === null && !session.master.killed;
  }

  /** Restart a dead control master (and its tunnel) at most every 10 s.
   * Concurrent callers share one starter: exactly one `ssh -N` runs per
   * restart, and a loser never overwrites the winner's master. */
  async ensureMaster(session: SshSession): Promise<void> {
    if (this.masterAlive(session)) return;
    const ongoing = session.masterStarting;
    if (ongoing) {
      await ongoing;
      return;
    }
    if (Date.now() - session.lastMasterStartAt < MASTER_RESTART_MIN_INTERVAL_MS) return;
    const starting = this.startMaster(session);
    session.masterStarting = starting;
    try {
      await starting;
    } finally {
      if (session.masterStarting === starting) session.masterStarting = null;
    }
  }

  private async startMaster(session: SshSession): Promise<void> {
    const key = await this.ensureKey();
    session.lastMasterStartAt = Date.now();
    const attempts: Array<TunnelSpec | null> = session.tunnelSpec ? [session.tunnelSpec, session.tunnelSpec, null] : [null];
    for (const tunnel of attempts) {
      // A concurrent closeSession/closeAll must win: never start (or retry)
      // a master for a session that is no longer registered.
      if (this.sessions.get(session.sandboxId) !== session) return;
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
      session.startingChild = child;
      // closeSession may have run between the loop-top check and spawn: a
      // removed session never gains a new master child.
      if (this.sessions.get(session.sandboxId) !== session) {
        session.startingChild = null;
        killQuietly(child);
        return;
      }
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const ready = await waitForControlSocket(child, session.controlPath, (session.connectTimeoutSec + 5) * 1000);
      if (session.startingChild === child) session.startingChild = null;
      if (ready) {
        // The session may have been closed or replaced while we waited for
        // the socket (or a concurrent starter won first): never resurrect a
        // dead session's master or overwrite the winner's.
        if (this.sessions.get(session.sandboxId) !== session
          || (session.master && session.master !== child && this.masterAlive(session))) {
          killQuietly(child);
          return;
        }
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
      if (tunnel) {
        if (this.sessions.get(session.sandboxId) !== session) return;
        await this.pause(2_000);
      }
    }
    // No master: commands fall back to one direct connection each. A removed
    // session stays untouched (no resurrecting log noise for a closed one).
    if (this.sessions.get(session.sandboxId) !== session) return;
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
    }, false, false);
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
    // Binary sync payloads are ours: nothing they start may outlive them.
    // run() also carries whole-run execute, whose commands may deliberately
    // detach a helper (`nohup server >log 2>&1 &`): a clean exit there only
    // deregisters the run, as the old unsupervised run() left it running.
    // A background job holding the channel's pipes never reaches a clean
    // exit, so timeouts still reach the group cancel below.
    cancelGroupOnCleanExit = true,
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
      result = await runStreamProcess("ssh", slave(wrapRemoteCommand(remoteCommand, runId, true, this.runRecordDir)), options);
      return { ...result, stderr: stripRunMarker(result.stderr, runId) };
    } finally {
      // Local pipe/cap errors throw, while timeouts return a result. Both must
      // finish bounded remote cleanup BEFORE releasing activity/rejecting. On
      // success this also removes the registration — and, for sync payloads,
      // any background children; a clean run() exit only deregisters (see
      // cancelGroupOnCleanExit). Never signal the shared master, and never
      // replace the original failure.
      // Exit 255 is ssh's own transport failure: the payload may have been
      // submitted and may still be running guest-side, so it is never a
      // proven completion — cancel, don't just deregister. (A payload that
      // itself exits 255 therefore also loses its background helpers.)
      const cleanExit = result !== undefined && !result.timedOut && result.signal === null && result.exitCode !== 255;
      const cleanupCommand = cleanExit && !cancelGroupOnCleanExit
        ? finalizeRemoteCommand(runId, this.runRecordDir)
        : cancelRemoteCommand(runId, this.runRecordDir);
      try {
        const cleanup = await runStreamProcess("ssh", slave(cleanupCommand), { timeoutMs: REMOTE_CANCEL_TIMEOUT_MS });
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
    // Also signal a still-connecting master: it is not in session.master
    // yet, and without this it would outlive shutdown until it connects or
    // times out. waitForControlSocket notices the exit within one poll, and
    // the liveness guards above stop the starter from retrying.
    if (session.startingChild) killQuietly(session.startingChild);
    session.startingChild = null;
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

/** Prefix for worker SSH key dirs under os.tmpdir(). */
export const STALE_KEY_DIR_PREFIX = "pcboat-";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the owner is gone. EPERM and any other error mean the
    // process exists or the result is uncertain: keep the dir.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** Pids of live ssh clients with dir on their command line (Linux /proc
 * scan). Null when the platform cannot answer (non-Linux, unreadable /proc):
 * keep-decisions treat unknown as "in use" (never reap what may be live),
 * best-effort kills treat it as "nothing to kill". */
async function sshPidsForDir(dir: string): Promise<number[] | null> {
  if (process.platform !== "linux") return null;
  let pids;
  try {
    pids = await readdir("/proc");
  } catch {
    return null;
  }
  const found: number[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "ssh") continue;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline.split("\0").some((part) => part.includes(dir))) continue;
      found.push(Number(pid));
    } catch {
      // /proc race: the process exited mid-scan.
    }
  }
  return found;
}

/** SIGTERM every ssh client multiplexing on sockets inside a dead worker's key
 * dir (Linux /proc scan). Best effort: a missed client only leaks until the
 * next sweep, and /proc races are ignored. Never touches live dirs. */
async function killStaleSshForDir(dir: string): Promise<void> {
  for (const pid of (await sshPidsForDir(dir)) ?? []) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** Remove worker key dirs whose owner pid is verifiably dead (kill(pid, 0)
 * reports ESRCH). Dirs predating the owner.pid marker are never reaped: going
 * idle is not dying — a still-running pre-upgrade worker whose master died and
 * whose last direct command finished has no live ssh client referencing its
 * dir, so age plus no referencing client cannot prove the owner dead. Legacy
 * unmarked dirs therefore leak until manual/ops cleanup. Only same-uid dirs
 * are considered: the uid is the boundary, and another user's key material is
 * never touched. Returns the removed dirs. Failures for one dir never block
 * the others. */
export async function cleanupStaleKeyDirs(baseDir: string = tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(baseDir);
  } catch {
    return removed;
  }
  const uid = process.getuid?.();
  for (const name of entries) {
    if (!name.startsWith(STALE_KEY_DIR_PREFIX)) continue;
    const dir = path.join(baseDir, name);
    let stat;
    try {
      stat = await lstat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (uid !== undefined && stat.uid !== uid) continue;
    let owner: string | null = null;
    try {
      owner = (await readFile(path.join(dir, "owner.pid"), "utf8")).trim();
    } catch {
      owner = null;
    }
    const pid = owner !== null && /^\d+$/.test(owner) ? Number(owner) : NaN;
    if (Number.isSafeInteger(pid)) {
      // Marked dir: liveness is verifiable by pid. (A recycled pid reads as
      // alive, which keeps the dir — the safe direction.)
      if (pidAlive(pid)) continue;
    } else {
      // Unmarked legacy dir (predates the owner.pid marker): never reaped.
      // Idle is not dead — a live pre-upgrade worker between commands has no
      // referencing ssh client — so no age/reference check can prove the
      // owner gone. These leak until manual/ops cleanup.
      continue;
    }
    await killStaleSshForDir(dir);
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Race: someone else reaped it.
    }
  }
  return removed;
}

function commonSshOptions(session: SshSession, privateKeyPath: string): string[] {
  return [
    // Never read the operator's ~/.ssh/config or /etc/ssh/ssh_config(.d):
    // a Host-* IdentityFile, RemoteForward or LocalCommand written for other
    // work must not ride connections to an untrusted guest. -F /dev/null
    // replaces both files; every setting the plugin needs is given below.
    "-F",
    "/dev/null",
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
