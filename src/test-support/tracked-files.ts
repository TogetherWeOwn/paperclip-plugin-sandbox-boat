import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * TrackedFilesFn seam for fixtures that are not git work trees: every regular
 * file or symlink under the root counts as tracked. Production uses the real
 * git listing (listTrackedFiles); fixtures exercising delta or guest
 * mechanics rather than admission inject this instead of running git.
 */
export async function listAllFilesAsTracked(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const entries = await readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(entryRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.add(entryRel);
      } else {
        const st = await lstat(path.join(root, entryRel)).catch(() => null);
        if (st?.isFile() || st?.isSymbolicLink()) out.add(entryRel);
      }
    }
  }
  return out;
}
