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
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface DepInstall {
  /** Lockfile relative path, e.g. package-lock.json. */
  lockfile: string;
  /** Guest argv for the install, run in the guest checkout. */
  install: string[];
}

export interface DepPlan {
  installs: DepInstall[];
  /** Combined sha256 over lockfile paths and bytes; the per-VM cache key. */
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

async function readIfFile(root: string, rel: string): Promise<Buffer | null> {
  const abs = path.join(root, rel);
  try {
    const info = await stat(abs);
    if (!info.isFile()) return null;
    return await readFile(abs);
  } catch {
    return null;
  }
}

/**
 * Plan guest installs from the source root's lockfiles. Returns null when
 * there is nothing to install from (no lockfile, unlocked manifest only, or
 * ambiguous competing lockfiles): the command stays local. Pass the tool so
 * ambiguity in the other ecosystem does not block this one.
 */
export async function planDependencies(sourceRoot: string, tool?: string): Promise<DepPlan | null> {
  const tables: Array<{ kind: "node" | "python"; entries: Array<{ file: string; install: string[] }> }> = [];
  if (tool !== "python") tables.push({ kind: "node", entries: NODE_LOCKFILES });
  if (tool !== "node" && tool !== "cargo") tables.push({ kind: "python", entries: PYTHON_LOCKFILES });
  const found: DepInstall[] = [];
  const hash = createHash("sha256");
  let ambiguous = false;
  for (const table of tables) {
    let matched: { file: string; install: string[] } | null = null;
    let count = 0;
    for (const candidate of table.entries) {
      const bytes = await readIfFile(sourceRoot, candidate.file);
      if (bytes === null) continue;
      count += 1;
      matched = candidate;
      hash.update(candidate.file);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
    if (table.kind === "python") {
      const reqBytes = await readIfFile(sourceRoot, "requirements.txt");
      if (reqBytes !== null) {
        if (isPinnedRequirements(reqBytes)) {
          count += 1;
          if (count === 1) matched = { file: "requirements.txt", install: PINNED_REQUIREMENTS_INSTALL };
          hash.update("requirements.txt");
          hash.update("\0");
          hash.update(reqBytes);
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
  if (ambiguous || found.length === 0) return null;
  return { installs: found, hash: hash.digest("hex") };
}
