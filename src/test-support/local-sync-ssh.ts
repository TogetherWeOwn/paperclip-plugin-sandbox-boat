// Only replace the network boundary. SshManager.run/runStream, the plugin,
// shell commands, local archivers and target filesystem operations stay real.
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runProcess, SshManager } from "../ssh.js";
import type { SshExecutionResult, SshSession } from "../ssh.js";

// Proposed production transport seam. Kept structural so baseline compiles and
// the missing API fails an assertion, not an import/type error. It must pipe
// binary stdin/stdout with backpressure and bounded diagnostic collection.
export interface StreamingSsh {
  runStream(session: SshSession, command: string, options: {
    stdin?: Readable;
    stdout?: Writable;
    // Without a sink, stdout is inline control output and must fail closed
    // above this cap (default 256 KiB), never truncate and report success.
    maxOutputBytes?: number;
    timeoutMs: number;
  }): Promise<SshExecutionResult>;
}

export interface TransferGate {
  direction: "in" | "out";
  afterBytes: number;
  reached: string;
  release: string;
  interrupt?: boolean;
}

export interface ProcessRecord {
  command: string;
  args: string[];
  stdinBytes: number;
  stdoutBytes: number;
  maxInputChunk: number;
  maxOutputChunk: number;
}

const runner = fileURLToPath(new URL("./local-sync-ssh.py", import.meta.url));

export class LocalSyncSsh extends SshManager {
  // A valid configured VM namespace, backed only by run-owned scratch. The
  // network stand-in translates it at exec, leaving production validation real.
  readonly remoteRoot = "/home/user/native-sync-fixture";
  readonly records: ProcessRecord[] = [];
  readonly bufferedPayloads: number[] = [];
  readonly sessionMap = new Map<string, SshSession>();
  private readonly children = new Set<ChildProcess>();
  gate?: TransferGate;
  exitCode?: number;
  spawnError = false;
  failLocalTar = false;
  archiveOverride?: string;
  // Literal test sentinels model VM-provided credentials; never inherit real
  // boat credentials from the test runner's environment.
  remoteEnv: Record<string, string> = {};

  constructor(readonly root: string, private readonly actualSpawn: typeof spawn) {
    super({ info() {}, warn() {} });
  }

  get archiveInjected(): string { return path.join(this.root, "archive-injected"); }

  remotePath(file: string): string {
    const localRoot = path.join(this.root, "sandbox");
    return file === localRoot || file.startsWith(`${localRoot}/`)
      ? `${this.remoteRoot}${file.slice(localRoot.length)}` : file;
  }

  // Never contact boat or invoke ssh/ssh-keygen. Only session setup is fake.
  override async ensureKey() {
    return { privateKeyPath: path.join(this.root, "unused-key"), publicKey: "ssh-ed25519 AAAATESTONLY" };
  }

  override async openSession(input: Parameters<SshManager["openSession"]>[0]): Promise<SshSession> {
    const session: SshSession = {
      ...input,
      knownHostsPath: path.join(this.root, "unused-known-hosts"),
      controlPath: path.join(this.root, "unused-control"),
      master: null,
      tunnel: "disabled",
      tunnelSpec: null,
      tunnelError: null,
      lastMasterStartAt: 0,
    };
    this.sessionMap.set(input.sandboxId, session);
    return session;
  }

  override getSession(id: string) { return this.sessionMap.get(id) ?? null; }
  override listSessions() { return [...this.sessionMap.values()]; }
  override masterAlive() { return true; }
  override async ensureMaster() {}
  override async closeSession(id: string) { this.sessionMap.delete(id); }
  override async closeAll() { this.sessionMap.clear(); }

  override async run(session: SshSession, command: string, options: { stdin?: string; timeoutMs: number }) {
    const result = await super.run(session, command, options);
    this.bufferedPayloads.push(Math.max(Buffer.byteLength(options.stdin ?? ""), Buffer.byteLength(result.stdout)));
    // run() carries inline control output (including pwd/runtime-ready paths).
    // Restore the VM namespace there; runStream's binary payload is untouched.
    return { ...result, stdout: result.stdout.replaceAll(path.join(this.root, "sandbox"), this.remoteRoot) };
  }

  /**
   * Control-only: one ssh invocation with no supervisor wrap, so a test can
   * prove the relay really exports the VM credentials that the supervised
   * paths strip. Production code never runs a command this way.
   */
  async runUnwrapped(session: SshSession, command: string, timeoutMs: number) {
    return await runProcess("ssh", ["-T", `${session.endpoint.user}@${session.endpoint.host}`, command], { timeoutMs });
  }

  // Passed to vi.mock(node:child_process). Every SSH exec launches the local
  // relay as an actual OS process; every other subprocess is real as well.
  readonly spawn = (command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess => {
    const record: ProcessRecord = {
      command, args: [...args], stdinBytes: 0, stdoutBytes: 0, maxInputChunk: 0, maxOutputChunk: 0,
    };
    this.records.push(record);
    const env = {
      PATH: process.env.PATH,
      HOME: this.root,
      TMPDIR: this.root,
      LC_ALL: "C",
    };
    let child: ChildProcess;
    if (command === "ssh") {
      if (args.includes("-N") || args.includes("-V")) throw new Error("unexpected SSH connection setup in local test");
      if (this.spawnError) {
        child = this.actualSpawn(path.join(this.root, "nonexistent-ssh"), [], { ...options, env });
      } else {
        const config = path.join(this.root, `ssh-call-${this.records.length}.json`);
        writeFileSync(config, JSON.stringify({
          root: this.root,
          command: `umask 022; ${args.at(-1)!.replaceAll(this.remoteRoot, path.join(this.root, "sandbox"))}`,
          gate: this.gate,
          exitCode: this.exitCode,
          archiveOverride: this.archiveOverride,
          archiveInjected: this.archiveInjected,
        }), { mode: 0o600 });
        child = this.actualSpawn("python3", [runner, config], { ...options, cwd: this.root, env: { ...env, ...this.remoteEnv } });
      }
    } else if (command === "tar" && this.failLocalTar) {
      child = this.actualSpawn("/bin/sh", ["-c", "printf 'test archiver failure\\n' >&2; exit 27"], { ...options, cwd: this.root, env });
    } else {
      child = this.actualSpawn(command, args, { ...options, cwd: options.cwd ?? this.root, env: { ...options.env, ...env } });
    }
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    if (child.stdin) {
      const stream = child.stdin;
      const write = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
        record.stdinBytes += length;
        record.maxInputChunk = Math.max(record.maxInputChunk, length);
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
    }
    if (child.stdout) {
      const stream = child.stdout;
      const emit = stream.emit.bind(stream);
      stream.emit = ((event: string, ...values: unknown[]) => {
        if (event === "data") {
          const chunk = values[0] as Buffer;
          record.stdoutBytes += chunk.byteLength;
          record.maxOutputChunk = Math.max(record.maxOutputChunk, chunk.byteLength);
        }
        return emit(event, ...values);
      }) as typeof stream.emit;
    }
    return child;
  };

  armGate(direction: "in" | "out", interrupt = false): TransferGate {
    this.gate = {
      direction, afterBytes: 64 * 1024, interrupt,
      reached: path.join(this.root, "gate-reached"), release: path.join(this.root, "gate-release"),
    };
    return this.gate;
  }

  async releaseGate() {
    if (this.gate) await writeFile(this.gate.release, "continue");
  }

  async cleanup() {
    await this.releaseGate();
    const children = [...this.children];
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    })));
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** No symlink traversal in the observer: an escape must never be followed. */
export async function regularFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  if (!existsSync(root)) return result;
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) result.push(...await regularFiles(file));
    else if (item.isFile()) result.push(file);
  }
  return result;
}

export async function populatedFiles(root: string): Promise<string[]> {
  return (await Promise.all((await regularFiles(root)).map(async (file) => ({ file, size: (await lstat(file)).size }))))
    .filter((entry) => entry.size > 0).map((entry) => entry.file);
}

export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function put(file: string, bytes: string | Buffer, mode = 0o644) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { mode });
}

/** Hand-built malicious ustar fixture; never used to implement a transfer. */
export function hostileTar(entries: { name: string; body?: string; link?: string; hardlink?: boolean }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.body ?? "");
    let name = entry.name;
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/");
      header.write(name.slice(0, split), 345, 155, "utf8");
      name = name.slice(split + 1);
    }
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = entry.link ? (entry.hardlink ? 49 : 50) : 48;
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
