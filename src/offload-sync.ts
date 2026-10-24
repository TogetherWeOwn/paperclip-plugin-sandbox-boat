// Delta workspace sync for offloaded heavy commands.
// Design: docs/adr/0001-heavy-command-offload.md, "Sync and returned writes".
//
// Before each command the broker freezes an immutable source snapshot, plans a
// content-hash delta against the previous upload, and pushes only changed
// files into the card workspace on the pool VM (rsync over the plugin's pinned
// SSH transport, --times so cargo fingerprints hold). After the command the
// guest is compared to the uploaded manifest and return-eligible writes
// (Cargo.lock, snapshots, server-allowlisted generated paths) are downloaded
// into a command-scoped staging directory for explicit local application.
//
// V1 never writes a returned change into the live workspace: there is no apply
// step and no apply API in this module, even when the local baseline is
// unchanged or a mutation lease token is supplied.
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";

export const SYNC_MANIFEST_VERSION = 1;

/** Default push/collect exclusions: caches, runtime state, secrets, private registry config. */
export const DEFAULT_SYNC_EXCLUDES: readonly string[] = [
  ".git/",
  "target/",
  "node_modules/",
  ".paperclip-runtime/",
  ".claude/",
  ".cargo/",
  ".boat-offload/",
  ".env",
  ".env.*",
];

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_STAGED_BYTES = 4 * 1024 * 1024;

export type SyncErrorCode =
  | "SYNC_ESCAPING_SYMLINK"
  | "SYNC_SPECIAL_FILE"
  | "SYNC_SOURCE_TOO_LARGE"
  | "SYNC_CONCURRENT_EDIT"
  | "SYNC_TRAVERSAL"
  | "SYNC_GUEST_READ";

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

/** Internal: a source file changed mid-read. The caller retries capture once, then reports never-started. */
class ConcurrentEdit extends Error {}

/** The filesystem surface capture/snapshot needs. Inject a wrapper in tests to simulate concurrent edits. */
export interface ManifestFs {
  readdir: typeof fsp.readdir;
  lstat: typeof fsp.lstat;
  readlink: typeof fsp.readlink;
  open: typeof fsp.open;
  copyFile: typeof fsp.copyFile;
  mkdir: typeof fsp.mkdir;
  chmod: typeof fsp.chmod;
  utimes: typeof fsp.utimes;
  symlink: typeof fsp.symlink;
  readFile: typeof fsp.readFile;
  rm: typeof fsp.rm;
}

export interface SyncFileEntry {
  /** Posix-style path relative to the source root. */
  path: string;
  size: number;
  mtimeMs: number;
  /** Permission bits (0o777 mask). */
  mode: number;
  /** Hex sha256 of the bytes, or of "offload-symlink\\0<target>" for links. */
  sha256: string;
  /** Set when the entry is an in-root relative symlink: its target. */
  symlink?: string;
}

export interface SourceManifest {
  version: typeof SYNC_MANIFEST_VERSION;
  /** Absolute source root the manifest was captured from (informational). */
  root: string;
  files: SyncFileEntry[];
  capturedAt: string;
}

export interface CaptureStats {
  files: number;
  bytes: number;
  elapsedMs: number;
}

export interface CaptureOptions {
  excludes?: readonly string[];
  maxBytes?: number;
  maxFiles?: number;
  fs?: ManifestFs;
  now?: () => number;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function symlinkHash(target: string): string {
  return sha256Hex(`offload-symlink\0${target}`);
}

interface ParsedExcludes {
  dirs: Set<string>;
  exactFiles: Set<string>;
  fileGlobs: RegExp[];
}

function parseExcludes(patterns: readonly string[]): ParsedExcludes {
  const dirs = new Set<string>();
  const exactFiles = new Set<string>();
  const fileGlobs: RegExp[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      dirs.add(pattern.slice(0, -1));
    } else if (pattern.includes("*")) {
      fileGlobs.push(new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`));
    } else {
      exactFiles.add(pattern);
    }
  }
  return { dirs, exactFiles, fileGlobs };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a root-relative posix path is excluded. Dir patterns match at any depth. */
function isExcluded(relPosix: string, isDir: boolean, parsed: ParsedExcludes): boolean {
  const segments = relPosix.split("/");
  for (let i = 0; i < segments.length - (isDir ? 0 : 1); i += 1) {
    if (parsed.dirs.has(segments[i]!)) return true;
  }
  if (isDir && parsed.dirs.has(segments[segments.length - 1]!)) return true;
  const base = segments[segments.length - 1]!;
  if (parsed.exactFiles.has(base)) return true;
  return parsed.fileGlobs.some((re) => re.test(base));
}

/** Resolve a manifest-relative path inside a root, rejecting traversal and absolute paths. */
function resolveWithin(root: string, rel: string): string {
  if (rel === "" || path.isAbsolute(rel)) {
    throw new SyncError("SYNC_TRAVERSAL", `refusing path outside the sync root: ${JSON.stringify(rel)}`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new SyncError("SYNC_TRAVERSAL", `refusing path outside the sync root: ${JSON.stringify(rel)}`);
  }
  return abs;
}

/**
 * resolveWithin plus a parent-link guard: lexical containment cannot see a
 * symlinked mirror parent redirecting every op below it. The leaf itself may
 * be a link (callers handle those); any link strictly between the root and the
 * leaf is refused. Nonexistent middles cannot be links, so the walk continues
 * upward through them; only a link present at check time is caught.
 */
export async function resolveContained(root: string, rel: string): Promise<string> {
  const abs = resolveWithin(root, rel);
  const stop = path.resolve(root);
  let dir = path.dirname(abs);
  while (dir.startsWith(stop + path.sep)) {
    const st = await fsp.lstat(dir).catch(() => null);
    if (st?.isSymbolicLink()) {
      throw new SyncError("SYNC_TRAVERSAL", `refusing ${JSON.stringify(rel)}: ${dir} is a symlink out of the mirror.`);
    }
    dir = path.dirname(dir);
  }
  return abs;
}

async function hashOpenFile(handle: fsp.FileHandle, preSize: number, preMtimeMs: number): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  const before = await handle.stat();
  if (before.size !== preSize || before.mtimeMs !== preMtimeMs) throw new ConcurrentEdit();
  const bytes = await handle.readFile();
  const after = await handle.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ConcurrentEdit();
  return { bytes, size: after.size, mtimeMs: after.mtimeMs };
}

/**
 * Hash every eligible file under root without following substituted symlinks:
 * each file is opened O_NOFOLLOW from a pre-read lstat, and the size/mtime
 * from that lstat must still hold after the read. Retries once on a
 * concurrent source edit, then throws SYNC_CONCURRENT_EDIT (the executor maps
 * that to never-started local fallback).
 */
export async function captureManifest(root: string, opts: CaptureOptions = {}): Promise<{ manifest: SourceManifest; stats: CaptureStats }> {
  const io: ManifestFs = opts.fs ?? (fsp as unknown as ManifestFs);
  const clock = opts.now ?? Date.now;
  const excludes = parseExcludes(opts.excludes ?? DEFAULT_SYNC_EXCLUDES);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const started = clock();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const files = await walkAndHash(root, io, excludes, maxBytes, maxFiles);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      return {
        manifest: { version: SYNC_MANIFEST_VERSION, root: path.resolve(root), files, capturedAt: new Date(clock()).toISOString() },
        stats: { files: files.length, bytes, elapsedMs: Math.max(0, clock() - started) },
      };
    } catch (error) {
      if (!(error instanceof ConcurrentEdit)) throw error;
    }
  }
  throw new SyncError("SYNC_CONCURRENT_EDIT", `source under ${root} changed during capture on both attempts; nothing was pushed.`);
}

async function walkAndHash(root: string, io: ManifestFs, excludes: ParsedExcludes, maxBytes: number, maxFiles: number): Promise<SyncFileEntry[]> {
  const base = path.resolve(root);
  const files: SyncFileEntry[] = [];
  let bytes = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? base : path.join(base, rel);
    const entries = await raceToRetry(() => io.readdir(abs, { withFileTypes: true }));
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const entryAbs = path.join(base, entryRel);
      if (entry.isSymbolicLink()) {
        const target = await raceToRetry(() => io.readlink(entryAbs));
        if (path.isAbsolute(target) || !withinRoot(base, path.dirname(entryAbs), target)) {
          throw new SyncError("SYNC_ESCAPING_SYMLINK", `refusing symlink ${entryRel} -> ${target}: it leaves the source root.`);
        }
        if (isExcluded(entryRel, false, excludes)) continue;
        const st = await raceToRetry(() => io.lstat(entryAbs));
        files.push({ path: entryRel, size: Buffer.byteLength(target), mtimeMs: st.mtimeMs, mode: st.mode & 0o777, sha256: symlinkHash(target), symlink: target });
      } else if (entry.isDirectory()) {
        if (isExcluded(entryRel, true, excludes)) continue;
        stack.push(entryRel);
      } else if (entry.isFile()) {
        if (isExcluded(entryRel, false, excludes)) continue;
        const pre = await raceToRetry(() => io.lstat(entryAbs));
        // Deleted, swapped for a link, or file<->dir exchanged anywhere between
        // readdir and read: retry the capture instead of throwing a raw errno.
        const handle = await raceToRetry(() => io.open(entryAbs, O_RDONLY | O_NOFOLLOW));
        try {
          const { bytes: content, size, mtimeMs } = await raceToRetry(() => hashOpenFile(handle, pre.size, pre.mtimeMs));
          bytes += size;
          if (bytes > maxBytes) throw new SyncError("SYNC_SOURCE_TOO_LARGE", `source under ${root} exceeds the ${maxBytes}-byte cap.`);
          files.push({ path: entryRel, size, mtimeMs, mode: pre.mode & 0o777, sha256: sha256Hex(content) });
          if (files.length > maxFiles) throw new SyncError("SYNC_SOURCE_TOO_LARGE", `source under ${root} exceeds the ${maxFiles}-file cap.`);
        } finally {
          await handle.close().catch(() => undefined);
        }
      } else {
        throw new SyncError("SYNC_SPECIAL_FILE", `refusing special file ${entryRel}: only regular files, directories and in-root symlinks sync.`);
      }
    }
  }
  return files;
}

function withinRoot(base: string, linkDir: string, target: string): boolean {
  const resolved = path.resolve(linkDir, target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function isRaceError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  // ENOENT/ENOTDIR: deleted or file<->dir swapped mid-walk. ELOOP: swapped for
  // a link (or O_NOFOLLOW refused one). ENXIO: device node vanished. EISDIR: a
  // file became a dir between list and read. EINVAL: a link became a regular
  // file between list and readlink.
  return code === "ELOOP" || code === "ENOENT" || code === "ENXIO" || code === "ENOTDIR" || code === "EISDIR" || code === "EINVAL";
}

/** Translate a structural source race into a capture retry; every other error propagates. */
async function raceToRetry<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isRaceError(error)) throw new ConcurrentEdit();
    throw error;
  }
}

/**
 * Capture the manifest and freeze an immutable copy under snapshotDir: later
 * live edits (or symlink swaps) cannot change what the push sends. Verifies
 * the frozen bytes hash to the manifest; on a hash/copy race retries the
 * whole capture once, then throws SYNC_CONCURRENT_EDIT.
 */
export async function captureSnapshot(
  root: string,
  snapshotDir: string,
  opts: CaptureOptions = {},
): Promise<{ manifest: SourceManifest; stats: CaptureStats }> {
  const io: ManifestFs = opts.fs ?? (fsp as unknown as ManifestFs);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const captured = await captureManifest(root, opts);
    if (await freezeAndVerify(root, snapshotDir, captured.manifest, io)) return captured;
  }
  throw new SyncError("SYNC_CONCURRENT_EDIT", `source under ${root} changed between hashing and snapshotting on both attempts; nothing was pushed.`);
}

async function freezeAndVerify(root: string, snapshotDir: string, manifest: SourceManifest, io: ManifestFs): Promise<boolean> {
  const base = path.resolve(root);
  const snap = path.resolve(snapshotDir);
  for (const entry of manifest.files) {
    const src = resolveWithin(base, entry.path);
    const dest = resolveWithin(snap, entry.path);
    await io.mkdir(path.dirname(dest), { recursive: true });
    if (entry.symlink !== undefined) {
      // Recreate the captured link; copying would follow the live path instead.
      await io.rm(dest, { force: true }).catch(() => undefined);
      await io.symlink(entry.symlink, dest);
      const frozen = await io.readlink(dest);
      if (frozen !== entry.symlink || symlinkHash(frozen) !== entry.sha256) return false;
      continue;
    }
    try {
      await io.copyFile(src, dest);
    } catch (error) {
      if (isRaceError(error)) return false; // Vanished or swapped mid-freeze: recapture.
      throw error;
    }
    await io.chmod(dest, entry.mode);
    // Node sets whole milliseconds only; the rsync production path preserves full precision.
    await io.utimes(dest, new Date(Math.floor(entry.mtimeMs)), new Date(Math.floor(entry.mtimeMs)));
    const frozen = await io.readFile(dest);
    if (sha256Hex(frozen) !== entry.sha256) return false;
  }
  return true;
}

export interface PushPlan {
  /** Entries whose bytes the guest mirror is missing or has stale. */
  toSend: SyncFileEntry[];
  /** Manifest paths removed since the previous upload: delete from the disposable guest mirror only. */
  toDeleteFromMirror: string[];
  bytesToSend: number;
}

/**
 * Content-hash delta: unchanged trees plan zero files; same-size/same-mtime
 * edits still match by hash, while mode/mtime-only edits plan a metadata-only
 * sync so the guest never keeps a stale executable bit or an older mtime.
 */
export function planPush(previous: SourceManifest | null, snapshot: SourceManifest): PushPlan {
  const prev = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  const toSend = snapshot.files.filter((f) => {
    const old = prev.get(f.path);
    return !old || old.sha256 !== f.sha256 || old.symlink !== f.symlink || old.mode !== f.mode || old.mtimeMs !== f.mtimeMs;
  });
  const current = new Set(snapshot.files.map((f) => f.path));
  const toDeleteFromMirror = (previous?.files ?? []).map((f) => f.path).filter((p) => !current.has(p));
  return { toSend, toDeleteFromMirror, bytesToSend: toSend.reduce((sum, f) => sum + f.size, 0) };
}

export interface TransferResult {
  files: number;
  bytes: number;
  skipped: number;
}

export interface GuestFileState {
  size: number;
  mtimeMs: number;
  sha256: string;
  symlink?: string;
  /** A link the guest planted that escapes its root: never followed, never staged. */
  escaping?: boolean;
}

/**
 * The guest side of a sync: push bytes in, prune obsolete inputs, scan hashes
 * out, read staged bytes back. LocalGuestStore is the temp-dir implementation
 * the unit tests run against; production pushes over rsync/SSH (see
 * buildRsyncPushArgs) and the executor wires the live transport.
 */
export interface GuestStore {
  push(snapshotDir: string, entries: SyncFileEntry[], guestDir: string): Promise<TransferResult>;
  pruneMirror(guestDir: string, relPaths: string[]): Promise<{ removed: number }>;
  scan(guestDir: string): Promise<Map<string, GuestFileState>>;
  /**
   * Stream one guest file, capped: at most maxBytes are ever buffered. Returns
   * null when the bytes are unavailable (missing, not a regular file, or over
   * maxBytes) so the caller keeps metadata and marks the artifact truncated.
   * Never follows symlinks. Throws SYNC_TRAVERSAL on traversal or a symlinked
   * parent; other errors propagate.
   */
  readBounded(guestDir: string, relPath: string, maxBytes: number): Promise<Buffer | null>;
}

export interface LocalGuestStoreOptions {
  /** Test hook: runs before each copy or metadata fix; throwing aborts the push mid-transfer. */
  beforeCopy?: (entry: SyncFileEntry) => void;
}

export class LocalGuestStore implements GuestStore {
  constructor(private readonly opts: LocalGuestStoreOptions = {}) {}

  async push(snapshotDir: string, entries: SyncFileEntry[], guestDir: string): Promise<TransferResult> {
    const snap = path.resolve(snapshotDir);
    const guest = path.resolve(guestDir);
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    for (const entry of entries) {
      const dest = await resolveContained(guest, entry.path);
      const match = await matchGuestEntry(dest, entry);
      if (match === "identical") {
        skipped += 1;
        continue;
      }
      this.opts.beforeCopy?.(entry);
      const src = resolveWithin(snap, entry.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (entry.symlink !== undefined) {
        await fsp.rm(dest, { recursive: true, force: true });
        await fsp.symlink(entry.symlink, dest);
      } else if (match === "metadata-only") {
        // Same bytes: fix the mode/mtime in place without rewriting the file.
        await fsp.chmod(dest, entry.mode);
        await fsp.utimes(dest, new Date(Math.floor(entry.mtimeMs)), new Date(Math.floor(entry.mtimeMs)));
      } else {
        const st = await fsp.lstat(dest).catch(() => null);
        if (st && (st.isSymbolicLink() || st.isDirectory())) await fsp.rm(dest, { recursive: true, force: true });
        await fsp.copyFile(src, dest);
        await fsp.chmod(dest, entry.mode);
        // Whole-millisecond floor: the most Node's utimes can set (rsync keeps full precision).
        await fsp.utimes(dest, new Date(Math.floor(entry.mtimeMs)), new Date(Math.floor(entry.mtimeMs)));
      }
      files += 1;
      bytes += match === "metadata-only" ? 0 : entry.size;
    }
    return { files, bytes, skipped };
  }

  async pruneMirror(guestDir: string, relPaths: string[]): Promise<{ removed: number }> {
    const guest = path.resolve(guestDir);
    let removed = 0;
    for (const rel of relPaths) {
      const abs = await resolveContained(guest, rel);
      const st = await fsp.lstat(abs).catch(() => null);
      if (!st || (!st.isFile() && !st.isSymbolicLink())) continue;
      await fsp.rm(abs, { force: true });
      removed += 1;
    }
    return { removed };
  }

  async scan(guestDir: string): Promise<Map<string, GuestFileState>> {
    const guest = path.resolve(guestDir);
    const excludes = parseExcludes(DEFAULT_SYNC_EXCLUDES);
    const out = new Map<string, GuestFileState>();
    const stack: string[] = [""];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      const abs = rel === "" ? guest : path.join(guest, rel);
      // Only real directories are ever pushed, but a planted link swapped in
      // mid-scan must not redirect the descent outside the mirror.
      const dirSt = await fsp.lstat(abs).catch(() => null);
      if (!dirSt) continue;
      if (dirSt.isSymbolicLink()) {
        throw new SyncError("SYNC_TRAVERSAL", `refusing to descend into symlinked guest dir ${rel === "" ? "." : rel}.`);
      }
      const entries = await fsp.readdir(abs, { withFileTypes: true }).catch((error: unknown) => {
        if (isGuestVanished(error)) return null;
        throw error;
      });
      if (!entries) continue;
      for (const entry of entries) {
        const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const entryAbs = path.join(guest, entryRel);
        if (entry.isSymbolicLink()) {
          if (isExcluded(entryRel, false, excludes)) continue;
          const target = await fsp.readlink(entryAbs).catch((error: unknown) => {
            if (isGuestVanished(error)) return null;
            throw error;
          });
          if (target === null) continue;
          const st = await fsp.lstat(entryAbs).catch(() => null);
          if (!st) continue;
          if (path.isAbsolute(target) || !withinRoot(guest, path.dirname(entryAbs), target)) {
            out.set(entryRel, { size: 0, mtimeMs: st.mtimeMs, sha256: "", escaping: true });
          } else {
            out.set(entryRel, { size: Buffer.byteLength(target), mtimeMs: st.mtimeMs, sha256: symlinkHash(target), symlink: target });
          }
        } else if (entry.isDirectory()) {
          if (isExcluded(entryRel, true, excludes)) continue;
          stack.push(entryRel);
        } else if (entry.isFile()) {
          if (isExcluded(entryRel, false, excludes)) continue;
          const hashed = await hashGuestFile(entryAbs);
          if (!hashed) continue; // Vanished mid-scan.
          if ("escaping" in hashed) {
            out.set(entryRel, { size: 0, mtimeMs: 0, sha256: "", escaping: true });
          } else {
            out.set(entryRel, { size: hashed.size, mtimeMs: hashed.mtimeMs, sha256: hashed.sha256 });
          }
        }
      }
    }
    return out;
  }

  async readBounded(guestDir: string, relPath: string, maxBytes: number): Promise<Buffer | null> {
    const abs = await resolveContained(path.resolve(guestDir), relPath);
    const pre = await fsp.lstat(abs).catch(() => null);
    if (!pre || !pre.isFile() || pre.size > maxBytes) return null;
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(abs, O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (isGuestVanished(error) || (error as { code?: string })?.code === "ELOOP") return null;
      throw error;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > maxBytes) return null;
      // Stream with an enforced cap: a file that grows mid-read still never
      // buffers more than maxBytes plus one chunk.
      const stream = handle.createReadStream();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of stream) {
          const buf = chunk as Buffer;
          total += buf.length;
          if (total > maxBytes) return null;
          chunks.push(buf);
        }
      } finally {
        stream.destroy();
      }
      return Buffer.concat(chunks);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

/** The guest changed under us (deleted path): skip it, never crash the collection. */
function isGuestVanished(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

type GuestHash = { size: number; mtimeMs: number; sha256: string } | { escaping: true } | null;

/** Stream-hash one guest file with bounded memory. Null when it vanishes; escaping when it is a link. */
async function hashGuestFile(abs: string): Promise<GuestHash> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(abs, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string })?.code === "ELOOP") return { escaping: true };
    if (isGuestVanished(error)) return null;
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    let size = 0;
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        size += buf.length;
        hash.update(buf);
      }
    } finally {
      stream.destroy();
    }
    return { size, mtimeMs: st.mtimeMs, sha256: hash.digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type GuestMatch = "identical" | "metadata-only" | "different";

/**
 * Compare a mirror path against a manifest entry. Same bytes with a stale
 * mode or mtime is metadata-only: the push fixes it in place without
 * rewriting the file. Mtimes compare floored, matching what utimes can set.
 */
async function matchGuestEntry(dest: string, entry: SyncFileEntry): Promise<GuestMatch> {
  const st = await fsp.lstat(dest).catch(() => null);
  if (!st) return "different";
  if (entry.symlink !== undefined) {
    if (!st.isSymbolicLink()) return "different";
    return (await fsp.readlink(dest)) === entry.symlink ? "identical" : "different";
  }
  if (!st.isFile()) return "different";
  if (st.size !== entry.size) return "different";
  if (sha256Hex(await fsp.readFile(dest)) !== entry.sha256) return "different";
  const modeOk = (st.mode & 0o777) === (entry.mode & 0o777);
  const mtimeOk = Math.floor(st.mtimeMs) === Math.floor(entry.mtimeMs);
  return modeOk && mtimeOk ? "identical" : "metadata-only";
}

export interface RsyncPushSpec {
  controlPath: string;
  user: string;
  host: string;
  port: number;
  privateKeyPath: string;
  knownHostsPath: string;
  hostKeyAlias: string;
  connectTimeoutSec?: number;
}

/** Null-separated --files-from payload for an explicit delta list. No shell is involved. */
export function renderFilesFromList(entries: ReadonlyArray<Pick<SyncFileEntry, "path">>): string {
  if (entries.length === 0) return "";
  return entries.map((e) => e.path).join("\0") + "\0";
}

/**
 * Pure argv for the production push: rsync from the immutable snapshot over the
 * plugin's pinned SSH transport (control-master reuse, host-key pinning, no
 * agent forwarding, no reverse tunnel). Times and modes are preserved; the
 * delta list comes on stdin (--files-from=- --from0); there is deliberately
 * no --delete flag: obsolete inputs are pruned by explicit bounded paths only.
 */
export function buildRsyncPushArgs(spec: RsyncPushSpec, snapshotDir: string, guestDir: string, files: readonly string[]): string[] {
  const ssh = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${spec.knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${spec.hostKeyAlias}`,
    "-o",
    "CheckHostIP=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    `ConnectTimeout=${spec.connectTimeoutSec ?? 10}`,
    "-o",
    `ControlPath=${spec.controlPath}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "LogLevel=ERROR",
    "-i",
    spec.privateKeyPath,
    "-p",
    String(spec.port),
  ].join(" ");
  return [
    "rsync",
    "-a",
    "--times",
    "--perms",
    "--checksum",
    "--timeout=30",
    "--files-from=-",
    "--from0",
    ...DEFAULT_SYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    "-e",
    ssh,
    `${snapshotDir.replace(/\/+$/, "")}/`,
    `${spec.user}@${spec.host}:${guestDir}`,
  ];
}

export interface ReturnPolicy {
  /** Server-owned generated paths eligible for return. V1 starts empty. */
  generatedAllowlist: readonly string[];
}

export const DEFAULT_RETURN_POLICY: ReturnPolicy = { generatedAllowlist: [] };

function globToRegExp(glob: string): RegExp {
  const placeholder = "\0";
  const withPlaceholder = glob.replaceAll("**", placeholder);
  const escaped = withPlaceholder.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${escaped.replaceAll(placeholder, ".*")}$`);
}

/** Cargo.lock at the root, snapshots at any depth, plus the generated allowlist. Nothing else returns. */
export function isReturnEligible(relPath: string, policy: ReturnPolicy): boolean {
  if (relPath === "Cargo.lock") return true;
  const base = relPath.split("/").pop() ?? "";
  if (base.endsWith(".snap") || base.endsWith(".snap.new")) return true;
  return policy.generatedAllowlist.some((glob) => globToRegExp(glob).test(relPath));
}

export type ReturnOp = "create" | "modify" | "proposed-delete";

export interface StagedChange {
  path: string;
  op: ReturnOp;
  /** False for writes outside the return set: retained bounded, reported separately, never silently dropped. */
  supported: boolean;
  baselineSha256: string | null;
  returnedSha256: string | null;
  /** Live-workspace hash observed at stage time (null when absent). Reading it never mutates live files. */
  liveSha256: string | null;
  /** Staged remote bytes under the artifact dir, or null for proposed deletes, escapes and over-cap entries. */
  stagedRelPath: string | null;
}

export interface StageResult {
  state: "clean" | "staged" | "conflict";
  changedPaths: string[];
  conflictPaths: string[];
  unsupportedPaths: string[];
  artifactDir: string | null;
  changes: StagedChange[];
  truncated: boolean;
}

export interface CollectOptions {
  liveRoot: string;
  uploaded: SourceManifest;
  guest: GuestStore;
  guestDir: string;
  stagingDir: string;
  policy?: ReturnPolicy;
  maxStagedBytes?: number;
  /**
   * Accepted and ignored: V1 is stage-first and has no apply path, so a
   * mutation lease cannot authorize a live write. Kept so callers that hold
   * one do not need a separate call shape.
   */
  mutationLease?: unknown;
}

/**
 * Compare the guest mirror to the uploaded manifest (whatever the command's
 * exit was) and download return-eligible writes into a command-scoped staging
 * directory. Never writes or deletes a live workspace file. Divergent local
 * content yields state conflict with both versions preserved. Guest bytes are
 * pre-checked against the staging budget and streamed through a capped read,
 * so an oversized guest file truncates the artifact instead of exhausting
 * memory.
 */
export async function collectAndStage(opts: CollectOptions): Promise<StageResult> {
  void opts.mutationLease;
  const policy = opts.policy ?? DEFAULT_RETURN_POLICY;
  const maxStagedBytes = opts.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES;
  const live = path.resolve(opts.liveRoot);
  const uploaded = new Map(opts.uploaded.files.map((f) => [f.path, f]));
  const guest = await opts.guest.scan(opts.guestDir);

  const changes: StagedChange[] = [];
  for (const [rel, state] of guest) {
    const baseline = uploaded.get(rel);
    if (!baseline) {
      changes.push(await newGuestChange(live, opts.guest, opts.guestDir, rel, state, policy));
    } else if (state.escaping || state.sha256 !== baseline.sha256 || state.symlink !== baseline.symlink) {
      changes.push(await modifiedGuestChange(live, opts.guest, opts.guestDir, rel, state, baseline, policy));
    }
  }
  for (const [rel, baseline] of uploaded) {
    if (!guest.has(rel)) {
      changes.push({ path: rel, op: "proposed-delete", supported: isReturnEligible(rel, policy), baselineSha256: baseline.sha256, returnedSha256: null, liveSha256: await liveHash(live, rel), stagedRelPath: null });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const conflictPaths = changes.filter((c) => isConflict(c)).map((c) => c.path);
  const state: StageResult["state"] = changes.length === 0 ? "clean" : conflictPaths.length > 0 ? "conflict" : "staged";
  if (changes.length === 0) {
    return { state, changedPaths: [], conflictPaths: [], unsupportedPaths: [], artifactDir: null, changes, truncated: false };
  }

  await fsp.mkdir(opts.stagingDir, { recursive: true });
  let remaining = maxStagedBytes;
  let truncated = false;
  let fileIndex = 0;
  for (const change of changes) {
    if (change.op === "proposed-delete" || change.returnedSha256 === null) continue;
    if ((guest.get(change.path)?.size ?? 0) > remaining) {
      truncated = true; // Too big per the scan: never even open it.
      continue;
    }
    const content = await opts.guest.readBounded(opts.guestDir, change.path, remaining);
    if (!content) {
      truncated = true; // Vanished, swapped, or grew past the budget: metadata is kept, bytes are not.
      continue;
    }
    fileIndex += 1;
    const stagedRelPath = `files/${String(fileIndex).padStart(4, "0")}/${change.path}`;
    const dest = resolveWithin(path.resolve(opts.stagingDir), stagedRelPath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content);
    change.stagedRelPath = stagedRelPath;
    remaining -= content.length;
  }

  const result: StageResult = {
    state,
    changedPaths: changes.map((c) => c.path),
    conflictPaths,
    unsupportedPaths: changes.filter((c) => !c.supported).map((c) => c.path),
    artifactDir: opts.stagingDir,
    changes,
    truncated,
  };
  await fsp.writeFile(
    path.join(opts.stagingDir, "manifest.json"),
    `${JSON.stringify({ version: 1, state: result.state, changedPaths: result.changedPaths, conflictPaths, unsupportedPaths: result.unsupportedPaths, truncated, changes }, null, 2)}\n`,
  );
  return result;
}

async function newGuestChange(
  live: string,
  guest: GuestStore,
  guestDir: string,
  rel: string,
  state: GuestFileState,
  policy: ReturnPolicy,
): Promise<StagedChange> {
  void guest;
  void guestDir;
  const supported = !state.escaping && isReturnEligible(rel, policy);
  return {
    path: rel,
    op: "create",
    supported,
    baselineSha256: null,
    returnedSha256: state.escaping ? null : state.sha256,
    liveSha256: await liveHash(live, rel),
    stagedRelPath: null,
  };
}

async function modifiedGuestChange(
  live: string,
  guest: GuestStore,
  guestDir: string,
  rel: string,
  state: GuestFileState,
  baseline: SyncFileEntry,
  policy: ReturnPolicy,
): Promise<StagedChange> {
  void guest;
  void guestDir;
  const supported = !state.escaping && isReturnEligible(rel, policy);
  return {
    path: rel,
    op: "modify",
    supported,
    baselineSha256: baseline.sha256,
    returnedSha256: state.escaping ? null : state.sha256,
    liveSha256: await liveHash(live, rel),
    stagedRelPath: null,
  };
}

/** Conflict: the live content/existence differs from the uploaded baseline on a path the guest also changed. */
function isConflict(change: StagedChange): boolean {
  if (change.op === "create") return change.liveSha256 !== null;
  if (change.op === "proposed-delete" && change.liveSha256 === null) return false; // Convergent delete.
  return change.liveSha256 !== change.baselineSha256;
}

async function liveHash(liveRoot: string, rel: string): Promise<string | null> {
  const abs = resolveWithin(liveRoot, rel);
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) return symlinkHash(await fsp.readlink(abs));
  if (!st.isFile()) return null;
  return sha256Hex(await fsp.readFile(abs));
}
