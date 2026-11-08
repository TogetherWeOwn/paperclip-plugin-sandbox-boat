// Guest dependency installation for Node/Python offload.
// Frozen source sync excludes node_modules, venvs and build outputs, so the
// guest installs dependencies from the lockfile into a per-VM cache keyed by
// lockfile hash: a warm pool VM reuses them across runs. Never installs from
// an unlocked manifest; a missing or ambiguous lockfile means the command
// stays local (decided host-side before any VM is spent). Python reproducibility
// requires uv.lock (`uv sync --frozen`) or hash-pinned requirements.txt
// (`pip install --require-hashes -r requirements.txt`); an unpinned
// requirements.txt stays local like a missing lockfile.

import { createHash } from "node:crypto";
import path from "node:path";
import { probeDir, probeFileExists, readProbeFile, type ProbeRead } from "./probe-file.js";
import { MAX_UV_EXTRA_LOCK_BYTES, MAX_UV_EXTRA_MANIFEST_BYTES, supportsLockedUvTestExtra } from "./uv-test-extra.js";

/** Explicit opt-in only; callers must carry the same selection through both
 * admission and guest installation. No inference from pytest or environment.
 * The cwd is source-root relative and is checked for nested Python projects. */
export interface DepSelection {
  uvExtra: "test";
  cwdRelative: string;
}

export interface DepInstall {
  /** Lockfile relative path, e.g. package-lock.json. */
  lockfile: string;
  /** Guest argv for the install, run in the guest checkout. */
  install: string[];
}

export interface DepPlan {
  installs: DepInstall[];
  /** Combined sha256 over lockfiles and any explicit selection/manifest. */
  hash: string;
}

/** Node lockfile -> installer, in priority order. */
const NODE_LOCKFILES: Array<{ file: string; install: string[] }> = [
  { file: "package-lock.json", install: ["npm", "ci"] },
  { file: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"] },
  { file: "yarn.lock", install: ["yarn", "install", "--frozen-lockfile"] },
];

/** Python lockfile -> installer, in priority order. */
const PYTHON_LOCKFILES: Array<{ file: string; install: string[] }> = [
  { file: "uv.lock", install: ["uv", "sync", "--frozen"] },
];

/** Pinned pip path: hash-pinned requirements.txt only, installed with hashes enforced. */
const PINNED_REQUIREMENTS_INSTALL = ["pip", "install", "--require-hashes", "-r", "requirements.txt"];

/**
 * True when requirements.txt is a pinned lockfile: at least one requirement,
 * every requirement pinned as `name[extras]==version` (with an optional
 * environment marker after `;`), every requirement carrying `--hash=sha256:`,
 * and no pip option lines (`-e`, `--extra-index-url`, `--index-url`, `-f`,
 * `--find-links`, `-r`, `-c`). Anything else is an unlocked manifest and
 * stays local.
 */
function isPinnedRequirements(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  // Join backslash continuations so hashes on the next line stay with their requirement.
  const joined = text.replace(/\\\r?\n/g, " ");
  const lines = joined.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) return false;
  for (const line of lines) {
    if (line.startsWith("-")) return false;
    if (!/^[A-Za-z0-9._-]+(\[[^\]]*\])?==[^\s;]+/.test(line)) return false;
    if (!line.includes("--hash=sha256:")) return false;
  }
  return true;
}

/** Lockfiles above this stay local: the bytes are hashed in worker memory. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;

/** Probe one lockfile candidate, keeping "missing" distinct from
 * "unreadable". Lockfiles are repo-controlled, so reads are no-follow with a
 * size cap (probe-file.ts). A candidate that exists but cannot be read
 * safely (symlink, non-regular, oversized) must refuse the plan for its
 * ecosystem rather than be treated as absent: otherwise it would silently
 * select another readable lockfile's installer. */
async function readIfFile(root: string, rel: string): Promise<ProbeRead> {
  return readProbeFile(path.join(root, rel), MAX_LOCKFILE_BYTES);
}

/**
 * A lockfile in a directory between the run directory (inclusive) and the
 * source root (exclusive): a separately locked sub-project whose dependencies
 * the root install would not provide, so the command stays local.
 */
export async function nestedLockfile(sourceRoot: string, cwdRelative: string, tool?: string): Promise<string | null> {
  const files = tool === "python" ? [...PYTHON_LOCKFILES.map((entry) => entry.file), "requirements.txt"] : NODE_LOCKFILES.map((entry) => entry.file);
  const segments = path.posix.normalize(cwdRelative).split("/").filter((part) => part !== "" && part !== ".");
  for (let depth = segments.length; depth > 0; depth--) {
    const prefix = segments.slice(0, depth);
    // Existence only, never a read. A symlinked prefix cannot be probed
    // safely, so fail closed: report the prefix itself as the blocker.
    const dir = await probeDir(sourceRoot, prefix);
    if (dir.kind === "unreadable") return path.posix.join(...prefix);
    if (dir.kind === "missing") continue;
    for (const file of files) {
      if (await probeFileExists(path.join(dir.dir, file))) return path.posix.join(...prefix, file);
    }
  }
  return null;
}

/**
 * Plan guest installs from the source root's lockfiles. Returns null when
 * there is nothing to install from (no lockfile, unlocked manifest only, or
 * ambiguous competing lockfiles): the command stays local. Pass the tool so
 * ambiguity in the other ecosystem does not block this one.
 */
export async function planDependencies(sourceRoot: string, tool?: string, selection?: DepSelection): Promise<DepPlan | null> {
  if (selection !== undefined) {
    // Runtime inputs need the same closed shape as the typed contract. A
    // selection cannot be ignored on another tool or fall back to pip.
    if (tool !== "python" || !selection || typeof selection !== "object"
      || Object.keys(selection).sort().join(",") !== "cwdRelative,uvExtra"
      || selection.uvExtra !== "test" || typeof selection.cwdRelative !== "string"
      || selection.cwdRelative.length > 4096 || !/^(?:\.|[A-Za-z0-9_-][A-Za-z0-9._/-]*)$/.test(selection.cwdRelative)
      || selection.cwdRelative.split("/").some((part) => part === ".." || part === "")) return null;
    if ((await probeDir(sourceRoot, selection.cwdRelative.split("/").filter((part) => part !== "."))).kind !== "ok") return null;
    if (await nestedLockfile(sourceRoot, selection.cwdRelative, "python")) return null;
    // A nested manifest without its own lock is also a separate project.
    const segments = selection.cwdRelative.split("/").filter((part) => part !== ".");
    for (let depth = segments.length; depth > 0; depth--) {
      if (await probeFileExists(path.join(sourceRoot, ...segments.slice(0, depth), "pyproject.toml"))) return null;
    }
  }
  const tables: Array<{ kind: "node" | "python"; entries: Array<{ file: string; install: string[] }> }> = [];
  if (tool !== "python") tables.push({ kind: "node", entries: NODE_LOCKFILES });
  if (tool !== "node" && tool !== "cargo") tables.push({ kind: "python", entries: PYTHON_LOCKFILES });
  const found: DepInstall[] = [];
  const hash = createHash("sha256");
  let ambiguous = false;
  // Only tables for the selected tool are built above, so an unreadable
  // candidate in the other ecosystem is never probed and cannot block here.
  let unreadable = false;
  let uvLock: Buffer | undefined;
  for (const table of tables) {
    let matched: { file: string; install: string[] } | null = null;
    let count = 0;
    for (const candidate of table.entries) {
      const probe = selection && candidate.file === "uv.lock"
        ? await readProbeFile(path.join(sourceRoot, candidate.file), MAX_UV_EXTRA_LOCK_BYTES)
        : await readIfFile(sourceRoot, candidate.file);
      if (probe.kind === "missing") continue;
      if (probe.kind === "unreadable") { unreadable = true; continue; }
      count += 1;
      if (candidate.file === "uv.lock") uvLock = probe.bytes;
      matched = candidate;
      hash.update(candidate.file);
      hash.update("\0");
      hash.update(probe.bytes);
      hash.update("\0");
    }
    if (table.kind === "python") {
      const reqProbe = await readIfFile(sourceRoot, "requirements.txt");
      if (reqProbe.kind === "unreadable") {
        // Present but not safely readable: cannot tell whether it is the
        // pinned lockfile, so refuse rather than plan from uv.lock alone.
        unreadable = true;
      } else if (reqProbe.kind === "ok") {
        if (isPinnedRequirements(reqProbe.bytes)) {
          count += 1;
          if (count === 1) matched = { file: "requirements.txt", install: PINNED_REQUIREMENTS_INSTALL };
          hash.update("requirements.txt");
          hash.update("\0");
          hash.update(reqProbe.bytes);
          hash.update("\0");
        }
        // An unpinned requirements.txt is an unlocked manifest: ignored, so a
        // coexisting uv.lock still plans. Python with only an unpinned
        // requirements.txt plans nothing and stays local.
      }
    }
    // Competing lockfiles for one ecosystem: do not guess which one wins.
    if (count > 1) ambiguous = true;
    if (matched && count === 1) found.push({ lockfile: matched.file, install: matched.install });
  }
  if (ambiguous || unreadable || found.length === 0) return null;
  if (selection) {
    const manifest = await readProbeFile(path.join(sourceRoot, "pyproject.toml"), MAX_UV_EXTRA_MANIFEST_BYTES);
    if (!uvLock || manifest.kind !== "ok" || !await supportsLockedUvTestExtra(manifest.bytes, uvLock)) return null;
    found[0] = { lockfile: "uv.lock", install: ["uv", "sync", "--frozen", "--extra", "test"] };
    hash.update("uv-extra\0test\0pyproject.toml\0");
    hash.update(manifest.bytes);
    hash.update("\0");
  }
  return { installs: found, hash: hash.digest("hex") };
}
