import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { syncFiles } from "./file-sync.js";
import { planDependencies } from "./offload/deps-install.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { captureSnapshot, collectAndStage, DEFAULT_SYNC_EXCLUDES, type GuestStore, type GuestFileState, type SourceManifest } from "./offload-sync.js";
import type { OffloadSync } from "./offload-journal.js";
import type { OffloadCommand } from "./offload.js";
import type { SshManager, SshSession } from "./ssh.js";

// Read-only guest inspection. No guest-supplied path becomes a host filename.
// Hash large files in chunks; only return-eligible bytes cross the bounded read.
const INSPECT = String.raw`
import base64, fnmatch, hashlib, json, os, stat, sys
root, action, argument, excludes = json.load(sys.stdin)
if os.path.realpath(root) != root:
    raise ValueError('symlinked guest workspace')
def excluded(name):
    return any(fnmatch.fnmatchcase(p, pattern.rstrip('/')) for p in name.split('/') for pattern in excludes)
def open_file(name):
    parts = name.split('/')
    if any(p in ('', '.', '..') for p in parts) or name.startswith('/'):
        raise ValueError('guest path escapes workspace')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
if action == 'read':
    name, cap = argument
    fd = open_file(name)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > cap:
            result = None
        else:
            contents = source.read(cap + 1)
            result = base64.b64encode(contents).decode() if len(contents) <= cap else None
else:
    result = {}
    total = 0
    stack = ['']
    while stack:
        relative = stack.pop()
        directory = root + ('/' + relative if relative else '')
        if os.path.realpath(directory) != directory:
            raise ValueError('symlinked scan directory')
        for entry in os.scandir(directory):
            name = relative + '/' + entry.name if relative else entry.name
            if excluded(name):
                continue
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                stack.append(name)
                if len(stack) > 100000:
                    raise ValueError('guest directory limit')
                continue
            total += info.st_size
            if total > 268435456 or len(result) >= 100000:
                raise ValueError('guest scan limit')
            value = {'size': info.st_size, 'mtimeMs': info.st_mtime * 1000}
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(entry.path)
                resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
                if target.startswith('/') or resolved == '..' or resolved.startswith('../'):
                    value.update({'escaping': True, 'sha256': ''})
                else:
                    value.update({'symlink': target, 'sha256': hashlib.sha256(('offload-symlink\0' + target).encode()).hexdigest()})
            elif stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256()
                fd = open_file(name)
                with os.fdopen(fd, 'rb') as source:
                    remaining = 268435456 - total + info.st_size
                    while True:
                        chunk = source.read(65536)
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        if remaining < 0:
                            raise ValueError('guest file grew past scan limit')
                        digest.update(chunk)
                value['sha256'] = digest.hexdigest()
            else:
                raise ValueError('special guest file')
            result[name] = value
print(json.dumps(result))
`;

export interface SshOffloadSyncDeps {
  ssh: SshManager;
  session(sandboxId: string): Promise<SshSession>;
  sourceRoot(command: OffloadCommand): Promise<string>;
  artifactRoot: string;
  workRoot?: string;
}

/** Frozen inbound native sync and bounded, staged-only return collection. */
export class SshOffloadSync implements OffloadSync {
  private readonly uploads = new Map<string, { source: string; manifest: SourceManifest; scratch: string; guestDir: string }>();
  /** Sandbox ids with a verified per-VM dependency cache entry (lockfile hash). */
  private readonly installed = new Map<string, Set<string>>();
  constructor(private readonly deps: SshOffloadSyncDeps) {}
  /** Guest-side content-addressed marker root for installed dependencies. */
  depCacheDir(): string { return path.posix.join(this.deps.workRoot ?? "/tmp", "paperclip-boat-deps"); }
  private key(command: OffloadCommand): string {
    return createHash("sha256").update(JSON.stringify([command.companyId, command.runId, command.commandId])).digest("hex");
  }
  directory(command: OffloadCommand): string { return path.posix.join(this.deps.workRoot ?? "/tmp", `paperclip-boat-work-${this.key(command)}`); }
  async cwd(_sandboxId: string, command: OffloadCommand): Promise<string> {
    const relative = command.cwdRelative ?? ".";
    if (path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "") || relative.includes("\0")) {
      throw new Error("Offload cwd escapes workspace");
    }
    return path.posix.join(this.directory(command), relative);
  }
  async push(sandboxId: string, command: OffloadCommand): Promise<void> {
    const source = await this.deps.sourceRoot(command);
    if (!path.isAbsolute(source) || await realpath(source) !== source) throw new Error("Offload source is not a canonical native workspace");
    await mkdir(this.deps.artifactRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(path.join(this.deps.artifactRoot, "command-"));
    try {
      const frozen = path.join(scratch, "source");
      await mkdir(frozen, { mode: 0o700 });
      const { manifest } = await captureSnapshot(source, frozen);
      const guestDir = this.directory(command);
      await syncFiles({ ssh: this.deps.ssh, session: await this.deps.session(sandboxId), timeoutMs: 300_000, remoteRoot: guestDir }, "in",
        [{ operationId: this.key(command), files: [{ sourcePath: frozen, targetPath: guestDir, kind: "directory" }] }]);
      await this.installDependencies(sandboxId, command, source, guestDir);
      this.uploads.set(this.key(command), { source, manifest, scratch, guestDir });
      await rm(frozen, { recursive: true, force: true });
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  /**
   * Install Node/Python dependencies on the guest from the source lockfile.
   * Frozen sync excludes dependency dirs, so a checkout without node_modules
   * cannot run until this installs them. The install runs once per lockfile
   * hash per VM (guest-side marker plus an in-memory set); a warm pool VM
   * reuses its cache across runs. Cargo checkouts skip this entirely.
   */
  async installDependencies(sandboxId: string, command: OffloadCommand, source: string, guestDir: string): Promise<void> {
    if ((command.tool ?? "cargo") === "cargo") return;
    const plan = await planDependencies(source, command.tool);
    if (!plan) {
      // resolve() keeps lockfile-less commands local before any VM is spent;
      // reaching here means the source changed under us. Never run unlocked.
      throw new Error("Offload node/python commands need a lockfile; refusing unlocked install");
    }
    const done = this.installed.get(sandboxId);
    if (done?.has(plan.hash)) return;
    const session = await this.deps.session(sandboxId);
    const marker = path.posix.join(this.depCacheDir(), `${plan.hash}.ok`);
    const check = await this.deps.ssh.runStream(session,
      buildRemoteCommand(`exec test -f ${shellQuote(marker)}`), { timeoutMs: 15_000 });
    if (check.exitCode === 0 && !check.timedOut && !check.signal) {
      this.markInstalled(sandboxId, plan.hash);
      return;
    }
    const steps = plan.installs
      .map((item) => `cd ${shellQuote(guestDir)} && ${item.install.map(shellQuote).join(" ")}`)
      .join(" && ");
    const script = `${steps} && mkdir -p ${shellQuote(this.depCacheDir())} && touch ${shellQuote(marker)}`;
    const result = await this.deps.ssh.runStream(session,
      buildRemoteCommand(`exec sh -c ${shellQuote(script)}`), { timeoutMs: 600_000, maxOutputBytes: 1_048_576 });
    if (result.exitCode !== 0 || result.timedOut || result.signal) {
      throw new Error("Offload dependency install failed; no command ran");
    }
    this.markInstalled(sandboxId, plan.hash);
  }
  private markInstalled(sandboxId: string, hash: string): void {
    let done = this.installed.get(sandboxId);
    if (!done) {
      done = new Set();
      this.installed.set(sandboxId, done);
    }
    done.add(hash);
  }
  async collect(sandboxId: string, command: OffloadCommand): Promise<unknown> {
    const upload = this.uploads.get(this.key(command));
    if (!upload) throw new Error("Missing frozen offload manifest; hold for reconciliation");
    const inspect = async <T>(action: string, argument: unknown, maxOutputBytes: number): Promise<T> => {
      const response = await this.deps.ssh.runStream(await this.deps.session(sandboxId),
        buildRemoteCommand(`exec python3 -I -c ${shellQuote(INSPECT)}`),
        { stdin: Readable.from([JSON.stringify([upload.guestDir, action, argument, DEFAULT_SYNC_EXCLUDES])]),
          timeoutMs: 60_000, maxOutputBytes });
      if (response.exitCode !== 0 || response.timedOut || response.signal) throw new Error("Offload return inspection failed");
      return JSON.parse(response.stdout) as T;
    };
    const guest: GuestStore = {
      push: async () => { throw new Error("Read-only return adapter"); },
      pruneMirror: async () => { throw new Error("Read-only return adapter"); },
      scan: async () => new Map(Object.entries(await inspect<Record<string, GuestFileState>>("scan", null, 16 * 1024 * 1024))),
      readBounded: async (_dir, relative, cap) => {
        const encoded = await inspect<string | null>("read", [relative, Math.min(cap, 4 * 1024 * 1024)], 6 * 1024 * 1024);
        return encoded === null ? null : Buffer.from(encoded, "base64");
      },
    };
    return collectAndStage({ liveRoot: upload.source, uploaded: upload.manifest, guest, guestDir: upload.guestDir,
      stagingDir: path.join(upload.scratch, "returned") });
  }
  async stage(sandboxId: string, command: OffloadCommand, collected: unknown) {
    const staged = collected as Awaited<ReturnType<typeof collectAndStage>>;
    const upload = this.uploads.get(this.key(command));
    if (!upload) throw new Error("Missing frozen offload manifest");
    // After collection, reclaim only this command's disposable guest checkout.
    // Returned artifacts remain private on persistent host storage for review.
    const cleanup = await this.deps.ssh.runStream(await this.deps.session(sandboxId),
      buildRemoteCommand(`exec python3 -I -c ${shellQuote("import shutil,sys; shutil.rmtree(sys.argv[1])")} ${shellQuote(upload.guestDir)}`),
      { timeoutMs: 15_000 });
    if (cleanup.exitCode !== 0 || cleanup.timedOut || cleanup.signal) throw new Error("Offload workspace cleanup unverified");
    if (!staged.artifactDir) await rm(upload.scratch, { recursive: true, force: true });
    this.uploads.delete(this.key(command));
    return { state: staged.state, changedPaths: staged.changedPaths, conflictPaths: staged.conflictPaths, artifactId: staged.artifactDir };
  }
}
