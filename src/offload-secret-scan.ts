// Tracked-file admission for offloaded commands.
//
// Only git-tracked files may leave the host: the sync manifest is built from
// `git ls-files --cached` intersected with the filesystem walk, so untracked
// or ignored workspace files (a stray .dev.vars, a local deploy key) never
// reach a pool VM. A source that is not a git work tree, or whose tracked
// files cannot be listed, stays local (fail closed).
//
// Before admission the tracked, sync-eligible files also go through a bounded
// content scan for known credential shapes (cloud keys, private-key headers,
// provider tokens, JWTs via the env-policy heuristic). Any hit keeps the
// command local. This is a heuristic net for well-known token formats, not a
// proof that a workspace is secret-free; the tracked-only rule and the sync
// excludes are the primary boundary.
import { execFile } from "node:child_process";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { containsJwt } from "./env-policy.js";

const execFileAsync = promisify(execFile);

/** Posix-style paths relative to the source root, as listed by git. */
export type TrackedFilesFn = (sourceRoot: string) => Promise<ReadonlySet<string> | null>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The tracked (index) files under sourceRoot, or null when the source is not
 * a git work tree or git fails for any reason. fsmonitor and hooks are
 * disabled so listing a hostile checkout cannot run repo-configured commands
 * in the plugin worker. Paths come back relative to sourceRoot, matching
 * `git -C <source> ls-files` semantics for a subdirectory checkout too.
 */
export async function listTrackedFiles(sourceRoot: string): Promise<Set<string> | null> {
  // No GIT_* variable from the worker env (GIT_DIR, GIT_INDEX_FILE, the
  // GIT_CONFIG_COUNT override family, ...) may redirect the listing to a
  // different repository, index or configuration than the bound source.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  env.GIT_OPTIONAL_LOCKS = "0";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", sourceRoot, "ls-files", "-z", "--cached"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", env },
    ));
  } catch {
    return null;
  }
  const files = new Set<string>();
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    // Git never emits these, but the set gates what may leave the host:
    // refuse the whole listing rather than trust a malformed entry.
    if (entry.startsWith("/") || entry.split("/").some((part) => part === ".." || part === "")) return null;
    files.add(entry);
  }
  return files;
}

/** Known credential shapes. Each pattern is linear in the scanned text. */
const SECRET_CONTENT_RES: readonly RegExp[] = [
  // AWS access key ids (long-term, temporary and account-scoped prefixes).
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  // PEM private keys of any flavour (RSA, EC, OPENSSH, PGP, plain).
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  // GitHub classic and fine-grained personal access tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Stripe live secret/restricted keys.
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/,
];

/** True when the content carries a known credential shape or a JWT anywhere in it. */
export function containsSecretContent(content: Buffer | string): boolean {
  const text = typeof content === "string" ? content : content.toString("latin1");
  if (containsJwt(text)) return true;
  return SECRET_CONTENT_RES.some((re) => re.test(text));
}

const MAX_SCAN_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Bounded scan of the given root-relative files. Returns true on the first
 * secret-shaped hit, and also when a file cannot be scanned within the bounds
 * (unreadable, special, oversized): admission fails closed to local. Tracked
 * paths missing from the work tree are skipped (the sync walk cannot see
 * them either), as are symlinks and directories such as submodule gitlinks,
 * whose contents are never in the tracked set.
 */
export async function hasSecretInFiles(root: string, relPaths: readonly string[]): Promise<boolean> {
  const base = path.resolve(root);
  let total = 0;
  for (const rel of relPaths) {
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) return true;
    const st = await lstat(abs).catch((error: NodeJS.ErrnoException) => error);
    if (st instanceof Error) {
      if (st.code === "ENOENT" || st.code === "ENOTDIR") continue;
      return true;
    }
    if (st.isSymbolicLink() || st.isDirectory()) continue;
    if (!st.isFile()) return true;
    if (st.size > MAX_SCAN_FILE_BYTES) return true;
    total += st.size;
    if (total > MAX_SCAN_TOTAL_BYTES) return true;
    let handle;
    try {
      handle = await open(abs, O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return true;
    }
    try {
      const content = await handle.readFile();
      if (containsSecretContent(content)) return true;
    } catch {
      return true;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return false;
}
