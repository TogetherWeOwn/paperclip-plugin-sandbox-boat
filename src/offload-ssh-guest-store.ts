// SSH GuestStore for offload delta push: the production transport behind the
// planPush delta core (src/offload-sync.ts). Planned files travel from the
// frozen host snapshot over the plugin's pinned SSH control master via rsync
// (-a --times --perms --checksum, explicit --files-from list, never --delete),
// while small bounded python helpers verify the per-card guest mirror, prune
// obsolete inputs, write the mirror marker and inspect returns. No guest path
// is trusted: every helper re-checks the mirror root and refuses symlinked
// parents before touching anything inside it.
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { runStreamProcess, type SshManager, type SshSession } from "./ssh.js";
import {
  buildRsyncPushArgs,
  DEFAULT_SYNC_EXCLUDES,
  renderFilesFromList,
  SyncError,
  type GuestFileState,
  type GuestStore,
  type SourceManifest,
  type SyncFileEntry,
  type TransferResult,
} from "./offload-sync.js";

/** Guest-side offload state dir inside a card mirror. Sync-excluded, never collected. */
export const MIRROR_DIR_NAME = ".boat-offload";
/** Mirror marker: which host manifest this mirror holds. Verified on every push. */
export const MIRROR_MARKER_RELPATH = `${MIRROR_DIR_NAME}/mirror.json`;
const RSYNC_TIMEOUT_MS = 300_000;
const MIRROR_OP_TIMEOUT_MS = 30_000;
const PRUNE_TIMEOUT_MS = 60_000;
const WIPE_TIMEOUT_MS = 60_000;

/** A planned mirror path, from our own manifest. The guest re-validates every one. */
export function assertMirrorRel(rel: string): void {
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\0")
    || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new SyncError("SYNC_TRAVERSAL", `refusing path outside the guest mirror: ${JSON.stringify(rel)}`);
  }
}

function assertGuestDir(guestDir: string): void {
  if (typeof guestDir !== "string" || !guestDir.startsWith("/") || guestDir.includes("\0")
    || guestDir.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) {
    throw new SyncError("SYNC_TRAVERSAL", `refusing guest dir outside the filesystem root: ${JSON.stringify(guestDir)}`);
  }
}

/** Wipes are bounded to per-card mirror basenames; nothing else is ever removed whole. */
function assertMirrorPath(guestDir: string): void {
  assertGuestDir(guestDir);
  const base = guestDir.split("/").pop()!;
  if (!/^paperclip-boat-mirror-[0-9a-f]{32}$/.test(base)) {
    throw new SyncError("SYNC_TRAVERSAL", `refusing to wipe a non-mirror guest path: ${JSON.stringify(guestDir)}`);
  }
}

/**
 * Stable identity of a manifest's file set: every field planPush compares
 * (path, size, mtime, mode, content hash, link target), never capture metadata.
 * Two captures of an untouched tree hash equal; any edit, chmod or touch moves it.
 */
export function hashManifest(manifest: SourceManifest): string {
  const canonical = [...manifest.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => [f.path, f.size, f.mtimeMs, f.mode, f.sha256, f.symlink ?? null]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface MirrorMarker {
  version: 1;
  mirrorKey: string;
  manifestHash: string;
}

export interface MirrorVerification {
  /** The stored marker, or null when absent, unreadable or malformed (full sync). */
  marker: MirrorMarker | null;
  /** A planned path made unsafe by a symlinked/file parent or a directory leaf (wipe + full sync). */
  suspect: string | null;
}

function isMarker(value: unknown): value is MirrorMarker {
  const marker = value as MirrorMarker;
  return !!marker && typeof marker === "object" && marker.version === 1
    && typeof marker.mirrorKey === "string" && marker.mirrorKey !== ""
    && typeof marker.manifestHash === "string" && /^[0-9a-f]{64}$/.test(marker.manifestHash);
}

// Verify the mirror, ensure it exists, and read its marker in one round trip.
// stdin: [mirrorDir, plannedRelPaths[]]. Every planned path's parents must be
// real directories or absent; a symlinked parent, a file where a directory must
// be, or a directory leaf where the host has a file/link makes the path suspect
// (rsync would follow or fail there), and the caller wipes the disposable mirror
// and fully resyncs instead of writing through it.
export const MIRROR_VERIFY_SCRIPT = String.raw`
# boat-offload-mirror-verify v1
import errno, json, os, stat, sys
mirror, planned = json.load(sys.stdin)
if not isinstance(mirror, str) or not isinstance(planned, list) or len(planned) > 200000:
    raise ValueError('invalid mirror verify input')
if os.path.realpath(os.path.dirname(mirror) or '/') != (os.path.dirname(mirror) or '/'):
    raise ValueError('symlinked mirror parent')
try:
    top = os.lstat(mirror)
except FileNotFoundError:
    os.makedirs(mirror, mode=0o700, exist_ok=True)
    top = os.lstat(mirror)
if not stat.S_ISDIR(top.st_mode) or os.path.islink(mirror) or os.path.realpath(mirror) != mirror:
    raise ValueError('mirror is not a real directory')
def parts_of(rel):
    if not isinstance(rel, str) or rel == '' or rel.startswith('/') or '\x00' in rel:
        raise ValueError('planned path escapes mirror')
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('planned path escapes mirror')
    return parts
def open_parent(parent):
    fd = os.open(mirror, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    done = False
    try:
        for part in parent:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    os.close(fd)
                    return None
                raise ValueError('suspect parent')
            os.close(fd)
            fd = nxt
        done = True
        return fd
    finally:
        if not done:
            os.close(fd)
suspect = None
checked = set()
for rel in planned:
    parts = parts_of(rel)
    parent = tuple(parts[:-1])
    if parent not in checked:
        checked.add(parent)
        try:
            fd = open_parent(list(parent))
        except ValueError:
            suspect = rel
            break
        if fd is not None:
            os.close(fd)
    if suspect is not None:
        break
    fd = open_parent(list(parent))
    try:
        if fd is None:
            continue
        try:
            leaf = os.lstat(parts[-1], dir_fd=fd)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(leaf.st_mode):
            suspect = rel
            break
    finally:
        if fd is not None:
            os.close(fd)
marker = None
try:
    root = os.open(mirror, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        state = os.open('.boat-offload', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            fd = os.open('mirror.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state)
            try:
                raw = os.read(fd, 4097)
            finally:
                os.close(fd)
        finally:
            os.close(state)
    finally:
        os.close(root)
    if len(raw) <= 4096:
        candidate = json.loads(raw.decode('utf8'))
        if isinstance(candidate, dict) and candidate.get('version') == 1 and isinstance(candidate.get('mirrorKey'), str) and candidate.get('mirrorKey') and isinstance(candidate.get('manifestHash'), str):
            marker = candidate
except OSError:
    marker = None
except ValueError:
    marker = None
print(json.dumps({'marker': marker, 'suspect': suspect}))
`;

// Prune obsolete inputs: unlink only regular files and links, refuse anything else.
export const MIRROR_PRUNE_SCRIPT = String.raw`
# boat-offload-mirror-prune v1
import errno, json, os, stat, sys
mirror, rels = json.load(sys.stdin)
if not isinstance(mirror, str) or not isinstance(rels, list) or len(rels) > 200000:
    raise ValueError('invalid mirror prune input')
if os.path.realpath(os.path.dirname(mirror) or '/') != (os.path.dirname(mirror) or '/'):
    raise ValueError('symlinked mirror parent')
if not os.path.isdir(mirror) or os.path.islink(mirror) or os.path.realpath(mirror) != mirror:
    raise ValueError('mirror is not a real directory')
removed = 0
for rel in rels:
    if not isinstance(rel, str) or rel == '' or rel.startswith('/') or '\x00' in rel:
        raise ValueError('prune path escapes mirror')
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('prune path escapes mirror')
    fd = os.open(mirror, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descended = True
        for part in parts[:-1]:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    descended = False
                    break
                raise ValueError('prune parent is not a real directory')
            os.close(fd)
            fd = nxt
        if not descended:
            continue
        try:
            leaf = os.lstat(parts[-1], dir_fd=fd)
        except FileNotFoundError:
            continue
        if stat.S_ISREG(leaf.st_mode) or stat.S_ISLNK(leaf.st_mode):
            os.unlink(parts[-1], dir_fd=fd)
            removed += 1
    finally:
        os.close(fd)
print(json.dumps({'removed': removed}))
`;

// Record which host manifest the mirror now holds. Atomic rename, never partial.
export const MIRROR_WRITE_SCRIPT = String.raw`
# boat-offload-mirror-write v1
import json, os, stat, sys
mirror, marker = json.load(sys.stdin)
if not isinstance(mirror, str) or not isinstance(marker, dict) or marker.get('version') != 1 or not isinstance(marker.get('mirrorKey'), str) or not marker.get('mirrorKey') or not isinstance(marker.get('manifestHash'), str):
    raise ValueError('invalid mirror marker input')
if os.path.realpath(os.path.dirname(mirror) or '/') != (os.path.dirname(mirror) or '/'):
    raise ValueError('symlinked mirror parent')
if not os.path.isdir(mirror) or os.path.islink(mirror) or os.path.realpath(mirror) != mirror:
    raise ValueError('mirror is not a real directory')
state = os.path.join(mirror, '.boat-offload')
try:
    os.mkdir(state, 0o700)
except FileExistsError:
    leaf = os.lstat(state)
    if not stat.S_ISDIR(leaf.st_mode) or os.path.islink(state):
        os.unlink(state)
        os.mkdir(state, 0o700)
if os.path.realpath(state) != state:
    raise ValueError('symlinked mirror state dir')
target = os.path.join(state, 'mirror.json')
tmp = f'{target}.tmp.{os.getpid()}'
with open(tmp, 'w', encoding='utf8') as out:
    out.write(json.dumps(marker))
os.replace(tmp, target)
print(json.dumps({'ok': True}))
`;

// Wipe a suspect mirror whole. Only the caller-selected mirror path is removed,
// never a parent or cache, and never through a link at the mirror path itself.
export const MIRROR_WIPE_SCRIPT = String.raw`
# boat-offload-mirror-wipe v1
import json, os, shutil, stat, sys
mirror = json.load(sys.stdin)[0]
if not isinstance(mirror, str):
    raise ValueError('invalid mirror wipe input')
if os.path.realpath(os.path.dirname(mirror) or '/') != (os.path.dirname(mirror) or '/'):
    raise ValueError('symlinked mirror parent')
try:
    top = os.lstat(mirror)
except FileNotFoundError:
    top = None
if top is not None:
    if os.path.islink(mirror):
        raise ValueError('refusing to wipe through a link at the mirror path')
    if not stat.S_ISDIR(top.st_mode):
        os.unlink(mirror)
        top = None
if top is not None:
    if os.path.realpath(mirror) != mirror:
        raise ValueError('symlinked mirror')
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError('safe mirror wipe is unavailable')
    shutil.rmtree(mirror)
os.mkdir(mirror, 0o700)
print(json.dumps({'ok': True}))
`;

// Read-only guest inspection. No guest-supplied path becomes a host filename.
// Hash large files in chunks; only return-eligible bytes cross the bounded read.
const GUEST_INSPECT_SCRIPT = String.raw`
# boat-offload-inspect v1
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

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { stdin: Readable; timeoutMs: number },
) => Promise<SpawnResult>;

async function defaultSpawn(command: string, args: string[], opts: { stdin: Readable; timeoutMs: number }): Promise<SpawnResult> {
  const result = await runStreamProcess(command, args, { stdin: opts.stdin, timeoutMs: opts.timeoutMs });
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut };
}

export interface SshGuestStoreDeps {
  ssh: SshManager;
  session: SshSession;
  /** Test seam: real rsync spawn by default. */
  spawn?: SpawnFn;
}

/**
 * The guest side of a sync over SSH: rsync delta push plus bounded mirror
 * helpers. One instance is bound to one session; callers rebuild it after a
 * session refresh. File counts report the plan (rsync --checksum may still skip
 * identical bytes inside a listed file without further round trips).
 */
export class SshGuestStore implements GuestStore {
  constructor(private readonly deps: SshGuestStoreDeps) {}

  private get spawn(): SpawnFn {
    return this.deps.spawn ?? defaultSpawn;
  }

  async push(snapshotDir: string, entries: SyncFileEntry[], guestDir: string): Promise<TransferResult> {
    if (entries.length === 0) return { files: 0, bytes: 0, skipped: 0 };
    if (!path.isAbsolute(snapshotDir)) {
      throw new SyncError("SYNC_TRAVERSAL", `refusing snapshot outside the filesystem root: ${JSON.stringify(snapshotDir)}`);
    }
    assertGuestDir(guestDir);
    for (const entry of entries) assertMirrorRel(entry.path);
    const key = await this.deps.ssh.ensureKey();
    const session = this.deps.session;
    const argv = buildRsyncPushArgs(
      {
        controlPath: session.controlPath,
        user: session.endpoint.user,
        host: session.endpoint.host,
        port: session.endpoint.port,
        privateKeyPath: key.privateKeyPath,
        knownHostsPath: session.knownHostsPath,
        hostKeyAlias: session.sandboxId,
        connectTimeoutSec: session.connectTimeoutSec,
      },
      snapshotDir,
      guestDir,
      entries.map((entry) => entry.path),
    );
    const [command, ...args] = argv;
    const result = await this.spawn(command!, args, {
      stdin: Readable.from([renderFilesFromList(entries)]),
      timeoutMs: RSYNC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.timedOut || result.signal) {
      throw new Error(
        `Offload delta push failed (exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}).`,
      );
    }
    return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), skipped: 0 };
  }

  async pruneMirror(guestDir: string, relPaths: string[]): Promise<{ removed: number }> {
    if (relPaths.length === 0) return { removed: 0 };
    assertGuestDir(guestDir);
    for (const rel of relPaths) assertMirrorRel(rel);
    const result = (await this.runScript(MIRROR_PRUNE_SCRIPT, [guestDir, relPaths], PRUNE_TIMEOUT_MS)) as { removed?: unknown };
    if (typeof result?.removed !== "number" || !Number.isSafeInteger(result.removed) || result.removed < 0) {
      throw new Error("Offload mirror prune returned an invalid removal count.");
    }
    return { removed: result.removed };
  }

  async scan(guestDir: string): Promise<Map<string, GuestFileState>> {
    const result = await this.inspect<Record<string, GuestFileState>>("scan", null, 16 * 1024 * 1024, guestDir);
    return new Map(Object.entries(result));
  }

  async readBounded(guestDir: string, relPath: string, maxBytes: number): Promise<Buffer | null> {
    const encoded = await this.inspect<string | null>("read", [relPath, Math.min(maxBytes, 4 * 1024 * 1024)], 6 * 1024 * 1024, guestDir);
    return encoded === null ? null : Buffer.from(encoded, "base64");
  }

  /**
   * Ensure the mirror exists as a real directory, flag planned paths an rsync
   * must not write through, and read the stored marker. The caller decides:
   * suspect -> wipe and full sync; marker agreeing with host state -> delta;
   * anything else -> full sync over the verified mirror.
   */
  async verifyMirror(guestDir: string, planned: string[]): Promise<MirrorVerification> {
    assertGuestDir(guestDir);
    for (const rel of planned) assertMirrorRel(rel);
    const result = (await this.runScript(MIRROR_VERIFY_SCRIPT, [guestDir, planned], MIRROR_OP_TIMEOUT_MS)) as {
      marker?: unknown;
      suspect?: unknown;
    };
    if (result?.suspect !== null && typeof result?.suspect !== "string") {
      throw new Error("Offload mirror verification returned an invalid suspect path.");
    }
    if (result?.marker !== null && !isMarker(result?.marker)) {
      throw new Error("Offload mirror verification returned a malformed marker.");
    }
    return { marker: (result?.marker as MirrorMarker | null) ?? null, suspect: (result?.suspect as string | null) ?? null };
  }

  async writeMarker(guestDir: string, marker: MirrorMarker): Promise<void> {
    assertGuestDir(guestDir);
    if (!isMarker(marker)) throw new Error("Refusing to write a malformed mirror marker.");
    const result = (await this.runScript(MIRROR_WRITE_SCRIPT, [guestDir, marker], MIRROR_OP_TIMEOUT_MS)) as { ok?: unknown };
    if (result?.ok !== true) throw new Error("Offload mirror marker write unverified.");
  }

  async wipeMirror(guestDir: string): Promise<void> {
    assertMirrorPath(guestDir);
    const result = (await this.runScript(MIRROR_WIPE_SCRIPT, [guestDir], WIPE_TIMEOUT_MS)) as { ok?: unknown };
    if (result?.ok !== true) throw new Error("Offload mirror wipe unverified.");
  }

  private async inspect<T>(action: string, argument: unknown, maxOutputBytes: number, guestDir: string): Promise<T> {
    return (await this.runScript(
      GUEST_INSPECT_SCRIPT,
      [guestDir, action, argument, DEFAULT_SYNC_EXCLUDES],
      60_000,
      maxOutputBytes,
    )) as T;
  }

  private async runScript(script: string, stdin: unknown, timeoutMs: number, maxOutputBytes = 1024 * 1024): Promise<unknown> {
    const response = await this.deps.ssh.runStream(
      this.deps.session,
      buildRemoteCommand(`exec python3 -I -c ${shellQuote(script)}`),
      { stdin: Readable.from([JSON.stringify(stdin)]), timeoutMs, maxOutputBytes },
    );
    if (response.exitCode !== 0 || response.timedOut || response.signal) {
      // Guest output can contain file bytes. Never echo it into the error.
      throw new Error(
        `Offload guest mirror operation failed (exit=${response.exitCode}, signal=${response.signal}, timedOut=${response.timedOut}).`,
      );
    }
    return JSON.parse(response.stdout) as unknown;
  }
}
