// Guest dependency installation for Node/Python offload.
// Frozen source sync excludes node_modules, venvs and build outputs, so the
// guest installs dependencies from the lockfile into a per-VM cache keyed by
// lockfile hash: a warm pool VM reuses them across runs. Never installs from
// an unlocked manifest; a missing or ambiguous lockfile means the command
// stays local (decided host-side before any VM is spent).

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
  { file: "requirements.txt", install: ["pip", "install", "-r", "requirements.txt"] },
];

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
 * ambiguous competing lockfiles): the command stays local.
 */
export async function planDependencies(sourceRoot: string): Promise<DepPlan | null> {
  const found: DepInstall[] = [];
  const hash = createHash("sha256");
  let ambiguous = false;
  for (const table of [NODE_LOCKFILES, PYTHON_LOCKFILES]) {
    let matched: { file: string; install: string[] } | null = null;
    let count = 0;
    for (const candidate of table) {
      const bytes = await readIfFile(sourceRoot, candidate.file);
      if (bytes === null) continue;
      count += 1;
      matched = candidate;
      hash.update(candidate.file);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
    // Competing lockfiles for one ecosystem: do not guess which one wins.
    if (count > 1) ambiguous = true;
    if (matched && count === 1) found.push({ lockfile: matched.file, install: matched.install });
  }
  if (ambiguous || found.length === 0) return null;
  return { installs: found, hash: hash.digest("hex") };
}
