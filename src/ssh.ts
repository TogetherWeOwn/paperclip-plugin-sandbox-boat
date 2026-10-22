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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
    options: { stdin?: string; timeoutMs: number },
  ): Promise<SshExecutionResult> {
    const key = await this.ensureKey();
    const args = [
      "-T",
      "-o",
      `ControlPath=${session.controlPath}`,
      "-o",
      "ControlMaster=no",
      ...commonSshOptions(session, key.privateKeyPath),
      `${session.endpoint.user}@${session.endpoint.host}`,
      remoteCommand,
    ];
    return await runProcess("ssh", args, { stdin: options.stdin, timeoutMs: options.timeoutMs });
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

/** Spawn a process, collect output, enforce a timeout. Secrets go through stdin only, never argv. */
export async function runProcess(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<SshExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
          }, options.timeoutMs)
        : null;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: timedOut ? null : code, signal: signal ?? null, timedOut, stdout, stderr });
    });
    if (options.stdin != null && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
