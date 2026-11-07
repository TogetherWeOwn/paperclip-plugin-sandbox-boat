// Tracked-file admission for offloaded commands.
//
// Only git-tracked files may leave the host: the sync manifest is built from
// `git ls-files --cached` intersected with the filesystem walk, so untracked
// or ignored workspace files (a stray .dev.vars, a local deploy key) never
// reach a pool VM. A source that is not a git work tree, or whose tracked
// files cannot be listed, stays local (fail closed). Because the guest only
// ever sees tracked files, a source with untracked, non-ignored files also
// stays local: the host build could read them and the guest build could not.
//
// Before admission the tracked, sync-eligible files also go through a bounded
// content scan for known credential shapes (cloud keys, private-key headers,
// provider tokens, JWTs via the env-policy heuristic). Any hit keeps the
// command local. This is a heuristic net for well-known token formats, not a
// proof that a workspace is secret-free; the tracked-only rule and the sync
// excludes are the primary boundary.
import { execFile, spawn } from "node:child_process";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { X509Certificate } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { containsJwt } from "./env-policy.js";

const execFileAsync = promisify(execFile);

/** Posix-style paths relative to the source root, as listed by git. */
export type TrackedFilesFn = (sourceRoot: string) => Promise<ReadonlySet<string> | null>;

/** True when the source has untracked, non-ignored files, or when that cannot be determined. */
export type UntrackedFilesFn = (sourceRoot: string) => Promise<boolean>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Worker env with every GIT_* override removed, so git sees only the bound source. */
function hardenedGitEnv(): NodeJS.ProcessEnv {
  // No GIT_* variable from the worker env (GIT_DIR, GIT_INDEX_FILE, the
  // GIT_CONFIG_COUNT override family, ...) may redirect the listing to a
  // different repository, index or configuration than the bound source.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function hardenedGitArgs(sourceRoot: string, ...args: string[]): string[] {
  return ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", sourceRoot, ...args];
}

/**
 * True when sourceRoot holds at least one untracked file git does not ignore
 * (`git ls-files --others --exclude-standard`). The mirror carries tracked
 * files only, so a tracked file that references such a file (a new module
 * before its first commit) builds on the host and fails on the guest: the
 * command must stay local. Untracked directories collapse to one entry and
 * the listing stops at the first entry, so the cost is bounded by the first
 * hit, not the size of the untracked tree. Any git failure (not a work tree,
 * timeout, oversized output, a signal) returns true: fail closed to local.
 * Same hardened invocation as listTrackedFiles.
 */
export function hasUntrackedFiles(sourceRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const child = spawn(
      "git",
      hardenedGitArgs(sourceRoot, "ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"),
      { env: hardenedGitEnv(), stdio: ["ignore", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => finish(true), GIT_TIMEOUT_MS);
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      // Any non-empty entry is a hit; a NUL-only chunk cannot occur, but a
      // stream that keeps growing without an entry is refused on size.
      if (chunk.some((byte) => byte !== 0) || bytes > GIT_MAX_BUFFER) finish(true);
    });
    child.on("error", () => finish(true));
    child.on("close", (code, signal) => finish(code !== 0 || signal !== null));
  });
}

/**
 * The tracked (index) files under sourceRoot, or null when the source is not
 * a git work tree or git fails for any reason. fsmonitor and hooks are
 * disabled so listing a hostile checkout cannot run repo-configured commands
 * in the plugin worker. Paths come back relative to sourceRoot, matching
 * `git -C <source> ls-files` semantics for a subdirectory checkout too.
 */
export async function listTrackedFiles(sourceRoot: string): Promise<Set<string> | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      hardenedGitArgs(sourceRoot, "ls-files", "-z", "--cached"),
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", env: hardenedGitEnv() },
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

/** Bounds for the certificate-only .pem exception: a public CA bundle fits
 * far inside them, and anything past them refuses instead of being judged. */
export const MAX_CERTIFICATE_PEM_BYTES = 256 * 1024;
const MAX_CERTIFICATE_PEM_BLOCKS = 64;

/**
 * True only when the content is provably nothing but X.509 certificates:
 * one or more `CERTIFICATE` PEM blocks (no other label — a `TRUSTED
 * CERTIFICATE` or any key block refuses), nothing but whitespace outside
 * the blocks, strict base64 inside them, and each block's DER both parses
 * as a certificate and byte-equals the parser's canonical re-encoding
 * (`cert.raw`). The byte-equality is load-bearing: OpenSSL parses a
 * certificate with garbage appended to its DER, so parse-alone would let
 * extra bytes ride along inside an otherwise-valid block. Certificates
 * are public material by construction (the ASN.1 type carries a public
 * key and a signature, never private key material), so bytes proven to
 * be exactly certificates may sync where an unverified `.pem` may not.
 * Anything malformed, mixed, oversized or carrying a known credential
 * shape returns false: the caller keeps the command local.
 */
export function isCertificateOnlyPem(content: Buffer | string): boolean {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (buf.length === 0 || buf.length > MAX_CERTIFICATE_PEM_BYTES) return false;
  if (containsSecretContent(buf)) return false;
  // PEM is printable ASCII plus line breaks and tabs; a NUL or high byte
  // anywhere means this is not the text format it claims to be.
  for (const byte of buf) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  const lines = buf.toString("latin1").split(/\r\n|\n/);
  let blocks = 0;
  let base64 = "";
  let padded = false;
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (line.trim() === "") continue;
      if (line !== "-----BEGIN CERTIFICATE-----") return false;
      blocks += 1;
      if (blocks > MAX_CERTIFICATE_PEM_BLOCKS) return false;
      base64 = "";
      padded = false;
      inBlock = true;
      continue;
    }
    if (line === "-----END CERTIFICATE-----") {
      if (base64 === "" || base64.length % 4 !== 0) return false;
      const der = Buffer.from(base64, "base64");
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(der);
      } catch {
        return false;
      }
      if (!cert.raw.equals(der)) return false;
      inBlock = false;
      continue;
    }
    // Base64 data lines only: no PEM headers (Proc-Type:, DEK-Info:), no
    // blank separator lines, and padding may appear only on the last line.
    if (padded || !/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return false;
    if (line.includes("=")) padded = true;
    base64 += line;
  }
  return !inBlock && blocks > 0;
}

/**
 * True only when every listed root-relative file is a regular file (never
 * a symlink, opened O_NOFOLLOW) whose bounded contents pass
 * isCertificateOnlyPem. A file that is missing, unreadable or oversized
 * fails: a tracked .pem must be present and verifiable on the host before
 * its bytes may be treated as public certificates.
 */
export async function pemFilesAreCertificateOnly(root: string, relPaths: readonly string[]): Promise<boolean> {
  const base = path.resolve(root);
  for (const rel of relPaths) {
    const abs = path.resolve(base, rel);
    if (abs === base || !abs.startsWith(base + path.sep)) return false;
    // O_NOFOLLOW protects only the leaf: a symlinked parent would let the
    // read escape the root, and capture (which never descends through a
    // link) would then silently omit a file admission verified. Every
    // ancestor below the root must be a real directory.
    const segments = rel.split("/");
    let ancestorOk = true;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const st = await lstat(path.join(base, ...segments.slice(0, depth))).catch(() => null);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) { ancestorOk = false; break; }
    }
    if (!ancestorOk) return false;
    const st = await lstat(abs).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_CERTIFICATE_PEM_BYTES) return false;
    let handle;
    try {
      // O_NONBLOCK so a regular-file-to-FIFO swap after the lstat cannot
      // park admission waiting for a writer; the handle stat then refuses
      // anything that is not a regular file.
      handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
      return false;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CERTIFICATE_PEM_BYTES) return false;
      // Capped read: a file grown past the bound after the stat is refused
      // on length, never buffered whole.
      const buf = Buffer.alloc(MAX_CERTIFICATE_PEM_BYTES + 1);
      let off = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, off, buf.length - off);
        if (bytesRead === 0) break;
        off += bytesRead;
        if (off > MAX_CERTIFICATE_PEM_BYTES) return false;
      }
      if (!isCertificateOnlyPem(buf.subarray(0, off))) return false;
    } catch {
      return false;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return true;
}

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
