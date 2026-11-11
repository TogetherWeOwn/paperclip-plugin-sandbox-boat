// Authenticated repository identity for the local-run offload allowlist.
//
// The workspace row's `repoUrl` and the checkout's on-disk
// `remote.origin.url` are both agent-writable: an agent that rewrites both
// to an allowlisted public repo can spoof the allowlist check that compares
// them, and the executor gate would then sync a private checkout's tracked
// source to pool VMs. Agreement of two agent-controlled strings is not a
// fact, so the allowlist also requires an authenticated remote fact:
//
//   - the claimed remote is contacted unauthenticated (`git ls-remote`)
//     and the checkout's HEAD commit is among its advertised refs, and
//   - the worktree files the sync would upload are byte-for-byte the HEAD
//     commit's blobs: every tree entry is hashed from its raw file bytes
//     and compared with the advertised commit's blob id, and the index
//     names exactly the HEAD tree's paths.
//
// No `git diff` is used: a worktree diff runs checkout-configured clean
// filters in the plugin worker and trusts index stat/flag state
// (assume-unchanged/skip-worktree), so it proves neither the synced bytes
// nor filter-free execution. Replacement refs are disabled for every
// object read, and every object read uses the pinned HEAD id rather than
// the mutable `HEAD` name, so a replaced or moved ref cannot substitute
// a different tree under the advertised id.
//
// Git itself does not hash-verify every object the proof trusts (`cat-file
// -t` reports only the type string, and byte verification behavior differs
// by command and git version), so the commit and every traversed tree are
// fetched raw and hash-verified here: sha1("<type> <len>\0"+content) must
// equal the referenced oid. The tree walk is the source of truth for blob
// oids; `ls-tree` is never used. Repositories whose advertised commit
// contains a gitlink (mode 160000, e.g. a submodule) stay local: a gitlink
// path contributes no bytes to verify, and its index path alone cannot
// prove the synced file at that path is the advertised commit's tree.
// Submodule checkouts therefore never bind.
//
// Any failure — unreachable remote, private/invalid remote, missing HEAD,
// dirty tree, timeout — fails closed: the caller stays local and never
// syncs. Only `https:` remotes are accepted: a local path or `file:` URL
// would let the agent point `ls-remote` at another local checkout and
// forge the proof, and an SSH URL would need credentials.
//
// The git invocations run with the agent checkout's configuration ignored
// (global/system config to /dev/null, hooks/fsmonitor off, terminal
// prompts off, protocols pinned to https, replace objects disabled), lazy
// fetching disabled (`GIT_NO_LAZY_FETCH=1` so a missing object cannot
// trigger a promisor fetch), askpass helpers emptied (`core.askPass=`),
// and an isolated empty `HOME` per invocation so neither `~/.netrc` nor
// ambient credential helpers can authenticate the supposedly unauthenticated
// `ls-remote`. `ls-remote` runs from the filesystem root so no checkout
// config is read for the network contact either.
//
// Raw-byte equality is intentionally strict: a checkout whose tracked
// files differ from the blob bytes by clean-filter attributes (line-ending
// conversion, Git LFS, ...) is not byte-provable without running those
// filters, so it stays local. sha256-object-format repositories stay
// local as well (only 40-hex sha1 bids verify).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_TREES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export type GitRunner = (
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: string; exit: number }>;

export type GitRunnerRaw = (
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: Buffer; exit: number }>;

export function hardenedGitEnv(isolatedHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  // Ambient credentials must not authenticate a supposedly unauthenticated
  // contact: `~/.netrc` (libcurl) and askpass programs are credential
  // channels the hardcoded `credential.helper=` cannot disable.
  delete env.SSH_ASKPASS;
  delete env.SSH_ASKPASS_REQUIRE;
  delete env.SUDO_ASKPASS;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_CACHE_HOME;
  delete env.XDG_DATA_HOME;
  delete env.CURL_HOME;
  if (isolatedHome !== undefined) env.HOME = isolatedHome;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  // A missing object must never lazy-fetch from a promisor remote: the
  // fetch could run checkout-configured askpass/credential helpers and
  // leak a network contact the proof does not account for.
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_PAGER = "cat";
  return env;
}

export const HARDENED_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.askPass=",
  "credential.helper=",
];

function gitArgs(...rest: string[]): string[] {
  return ["--no-replace-objects", ...HARDENED_GIT_CONFIG.flatMap((item) => ["-c", item]), ...rest];
}

export function makeIsolatedHome(): string | null {
  try {
    return mkdtempSync(path.join(tmpdir(), "boat-git-home-"));
  } catch {
    return null;
  }
}

function cleanupHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort: an empty directory in the temp area is harmless
  }
}

function runGitReal(args: string[], opts: { cwd?: string }): Promise<{ stdout: string; exit: number }> {
  const home = makeIsolatedHome();
  if (home === null) return Promise.resolve({ stdout: "", exit: 128 });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { stdout: string; exit: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      cleanupHome(home);
      resolve(value);
    };
    const child = spawn("git", args, { env: hardenedGitEnv(home), cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ stdout: "", exit: 124 }), GIT_TIMEOUT_MS);
    let stdout = "";
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) {
        finish({ stdout: "", exit: 124 });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish({ stdout: "", exit: 128 }));
    child.on("close", (code, signal) => finish({ stdout, exit: code ?? (signal ? 128 : 0) }));
  });
}

function runGitRawReal(args: string[], opts: { cwd?: string }): Promise<{ stdout: Buffer; exit: number }> {
  const home = makeIsolatedHome();
  if (home === null) return Promise.resolve({ stdout: Buffer.alloc(0), exit: 128 });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { stdout: Buffer; exit: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      cleanupHome(home);
      resolve(value);
    };
    const child = spawn("git", args, { env: hardenedGitEnv(home), cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ stdout: Buffer.alloc(0), exit: 124 }), GIT_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) {
        finish({ stdout: Buffer.alloc(0), exit: 124 });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish({ stdout: Buffer.alloc(0), exit: 128 }));
    child.on("close", (code, signal) => finish({ stdout: Buffer.concat(chunks), exit: code ?? (signal ? 128 : 0) }));
  });
}

function parseRemoteOids(stdout: string): Set<string> {
  const oids = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([0-9a-f]{40})[ \t](\S.*)$/.exec(trimmed);
    if (match) oids.add(match[1]!);
  }
  return oids;
}

function parseHeadOid(stdout: string): string | null {
  const oid = stdout.trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Claimed remote must be a plain https URL with no credentials. */
export function isAuthenticatableRemoteUrl(repoUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  return true;
}

/** Git blob id (sha1) of raw bytes: the bytes the sync would upload. */
function gitBlobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Git object id (sha1) of a raw commit/tree object: "<type> <len>\0"+content. */
function gitObjectHash(type: "commit" | "tree", content: Buffer): string {
  return createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex");
}

interface TreeEntry { mode: string; type: string; oid: string; rel: string }

function isSafeRelativePath(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((part) => part !== "" && part !== "..");
}

/** Tree oid (40-hex) from a raw commit's header, else null. */
function parseCommitTreeOid(raw: Buffer): string | null {
  if (raw.length < 48) return null;
  const newline = raw.indexOf(0x0a);
  if (newline < 0) return null;
  const firstLine = raw.subarray(0, newline).toString("utf8");
  const match = /^tree ([0-9a-f]{40})$/.exec(firstLine);
  return match ? match[1]! : null;
}

interface RawTreeChild {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a raw tree object (binary "<mode> <name>\0<20-byte oid>" entries). */
function parseRawTree(raw: Buffer): RawTreeChild[] | null {
  const children: RawTreeChild[] = [];
  let off = 0;
  while (off < raw.length) {
    const space = raw.indexOf(0x20, off);
    if (space < 0) return null;
    const mode = raw.subarray(off, space).toString("ascii");
    if (!/^(100644|100755|120000|160000|40000|040000)$/.test(mode)) return null;
    const nul = raw.indexOf(0x00, space + 1);
    if (nul < 0) return null;
    const nameBytes = raw.subarray(space + 1, nul);
    if (nameBytes.length === 0) return null;
    const name = nameBytes.toString("utf8");
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
    if (nul + 21 > raw.length) return null;
    const oid = raw.subarray(nul + 1, nul + 21).toString("hex");
    if (!/^[0-9a-f]{40}$/.test(oid)) return null;
    children.push({ mode, name, oid });
    off = nul + 21;
  }
  return children;
}

/** Parse `git ls-files -z --cached --full-name` output; null when malformed. */
function parseIndexPaths(stdout: string): Set<string> | null {
  const paths = new Set<string>();
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    if (paths.size >= MAX_ENTRIES) return null;
    if (!isSafeRelativePath(entry)) return null;
    paths.add(entry);
  }
  return paths;
}

/**
 * Byte size when the worktree entry at `rel` is exactly the tree blob
 * `entry`, else null (caller stays local). Regular files are hashed from
 * raw bytes (never through a filter); symlinks are hashed from their
 * target string without following the link. Ancestors must be real
 * directories so a symlinked parent cannot redirect the read outside
 * the checkout. Anything missing, special, oversized or unreadable is
 * null.
 */
async function worktreeBlobBytes(root: string, entry: TreeEntry): Promise<number | null> {
  const base = path.resolve(root);
  const abs = path.resolve(base, entry.rel);
  if (abs === base || !abs.startsWith(base + path.sep)) return null;
  const segments = entry.rel.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = await lstat(path.join(base, ...segments.slice(0, depth))).catch(() => null);
    if (!ancestor || ancestor.isSymbolicLink() || !ancestor.isDirectory()) return null;
  }
  if (entry.mode === "120000") {
    const target = await readlink(abs).catch(() => null);
    if (target === null) return null;
    return gitBlobHash(Buffer.from(target, "utf8")) === entry.oid ? Buffer.byteLength(target) : null;
  }
  if (entry.mode !== "100644" && entry.mode !== "100755") return null;
  const st = await lstat(abs).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return null;
  let handle;
  try {
    handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let off = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, off, buf.length - off);
      if (bytesRead === 0) break;
      off += bytesRead;
      if (off > MAX_FILE_BYTES) return null;
    }
    return gitBlobHash(buf.subarray(0, off)) === entry.oid ? off : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Git's effective worktree root must be exactly the bound source and the
 * bound source must be that root (not a subdirectory of it). On-disk
 * `core.worktree` is checkout-controlled: if it relocates the effective
 * root, `ls-files --full-name` entries and worktree bytes are resolved in
 * different coordinates than the sync (which lists relative to the bound
 * source via plain `ls-files`), so agreement can be an artifact of path
 * translation rather than the advertised tree. Fail closed unless the
 * coordinates are pinned to the bound source.
 */
async function isPinnedWorktreeRoot(localPath: string, runGit: GitRunner): Promise<boolean> {
  let top: { stdout: string; exit: number };
  try {
    top = await runGit(gitArgs("-C", localPath, "rev-parse", "--show-toplevel", "--show-prefix"), {});
  } catch {
    return false;
  }
  if (top.exit !== 0) return false;
  const lines = top.stdout.split("\n");
  const claimedTop = (lines[0] ?? "").trim();
  const prefix = lines[1] ?? "";
  if (claimedTop === "" || prefix !== "") return false;
  const [canonicalLocal, canonicalTop] = await Promise.all([
    realpath(localPath).catch(() => null),
    realpath(claimedTop).catch(() => null),
  ]);
  if (canonicalLocal === null || canonicalTop === null) return false;
  return canonicalTop === canonicalLocal;
}

/**
 * Totally unauthenticated proof that the checkout's HEAD is served by the
 * claimed remote and the synced bytes are exactly that commit's blobs.
 * Test seam: inject `runGit`/`runGitRaw`; production uses the real git
 * runners. Every failure returns false — the caller must stay local.
 */
export async function authenticateRepoInner(
  repoUrl: string,
  localPath: string,
  runGit: GitRunner = runGitReal,
  runGitRaw: GitRunnerRaw = runGitRawReal,
): Promise<boolean> {
  if (!isAuthenticatableRemoteUrl(repoUrl)) return false;
  if (!await isPinnedWorktreeRoot(localPath, runGit)) return false;
  const claimed = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  // Local identity first so a non-repository fails fast without any
  // network contact; the remote only confirms a HEAD the checkout has.
  let head: { stdout: string; exit: number };
  try {
    head = await runGit(gitArgs("-C", localPath, "rev-parse", "--verify", "HEAD"), {});
  } catch {
    return false;
  }
  const headOid = head.exit === 0 ? parseHeadOid(head.stdout) : null;
  if (!headOid) return false;
  // Verify the commit object itself: git reports only its type string on
  // `cat-file -t`, which a forged loose object stored under the advertised
  // oid satisfies. Hash the raw commit and require it to equal the oid.
  let commit: { stdout: Buffer; exit: number };
  try {
    commit = await runGitRaw(gitArgs("-C", localPath, "cat-file", "commit", headOid), {});
  } catch {
    return false;
  }
  if (commit.exit !== 0) return false;
  if (gitObjectHash("commit", commit.stdout) !== headOid) return false;
  const rootTreeOid = parseCommitTreeOid(commit.stdout);
  if (!rootTreeOid) return false;
  // Walk the commit's trees from raw objects, verifying each tree's hash
  // before trusting its entries. This is the source of truth for blob
  // oids — `ls-tree` is not used. A gitlink (mode 160000) cannot be
  // byte-verified, so any commit containing one stays local.
  const entries: TreeEntry[] = [];
  const seenPaths = new Set<string>();
  const stack: { oid: string; prefix: string }[] = [{ oid: rootTreeOid, prefix: "" }];
  let treeCount = 0;
  while (stack.length > 0) {
    const { oid, prefix } = stack.pop()!;
    treeCount += 1;
    if (treeCount > MAX_TREES) return false;
    let tree: { stdout: Buffer; exit: number };
    try {
      tree = await runGitRaw(gitArgs("-C", localPath, "cat-file", "tree", oid), {});
    } catch {
      return false;
    }
    if (tree.exit !== 0) return false;
    if (gitObjectHash("tree", tree.stdout) !== oid) return false;
    const children = parseRawTree(tree.stdout);
    if (children === null) return false;
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      if (!isSafeRelativePath(rel)) return false;
      if (child.mode === "160000") return false;
      if (child.mode === "40000" || child.mode === "040000") {
        if (stack.length + treeCount > MAX_TREES) return false;
        stack.push({ oid: child.oid, prefix: rel });
        continue;
      }
      if (entries.length >= MAX_ENTRIES) return false;
      if (seenPaths.has(rel)) return false;
      seenPaths.add(rel);
      entries.push({ mode: child.mode, type: "blob", oid: child.oid, rel });
    }
  }
  // The index must name exactly the HEAD tree's paths: staged extras
  // would be synced without being part of the advertised commit, and
  // staged deletions would hide part of it. The index flags themselves
  // (assume-unchanged/skip-worktree) are never trusted — bytes are
  // hashed from the worktree below.
  let index: { stdout: string; exit: number };
  try {
    index = await runGit(gitArgs("-C", localPath, "ls-files", "-z", "--full-name", "--cached"), {});
  } catch {
    return false;
  }
  if (index.exit !== 0) return false;
  const indexPaths = parseIndexPaths(index.stdout);
  if (!indexPaths) return false;
  const treePaths = new Set(entries.map((entry) => entry.rel));
  if (treePaths.size !== indexPaths.size) return false;
  for (const rel of treePaths) if (!indexPaths.has(rel)) return false;
  // Unauthenticated advertisement from a neutral cwd so no checkout
  // config (insteadOf, credential helpers, proxies) can rewrite or
  // annotate the contact; an unreachable or private remote fails here.
  let remote: { stdout: string; exit: number };
  try {
    remote = await runGit(gitArgs("ls-remote", "--", claimed), { cwd: path.parse(localPath).root });
  } catch {
    return false;
  }
  if (remote.exit !== 0) return false;
  const advertised = parseRemoteOids(remote.stdout);
  if (advertised.size === 0) return false;
  if (!advertised.has(headOid)) return false;
  // The synced bytes are the worktree files, not the commit object: a
  // HEAD that matches the remote but different file bytes would still
  // leak. Require every entry's raw bytes to hash to its blob.
  let total = 0;
  for (const entry of entries) {
    const bytes = await worktreeBlobBytes(localPath, entry);
    if (bytes === null) return false;
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return false;
  }
  return true;
}

type RepoAuthOverride = (repoUrl: string, localPath: string) => Promise<boolean>;
let override: RepoAuthOverride | null = null;

/** Test hook, mirroring setBoatApiFactoryForTests. Production never sets this. */
export function setRepoAuthForTests(fn: RepoAuthOverride | null): void {
  override = fn;
}

export async function authenticateRepo(repoUrl: string, localPath: string): Promise<boolean> {
  if (override) return override(repoUrl, localPath);
  return authenticateRepoInner(repoUrl, localPath);
}
