// Bounded, no-follow reads of workspace probe files (toolchain pins,
// lockfiles). The workspace is repo-controlled: a probe path can be a symlink
// to /dev/zero, a FIFO, or a multi-GB host file, and a plain readFile in the
// plugin worker would follow it and buffer without limit, exhausting host
// memory or hanging. Every probe therefore opens with O_NOFOLLOW|O_NONBLOCK,
// requires a regular file under a byte cap, and reads at most cap+1 bytes.
// Anything else is "unreadable" and the command stays local.

import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export type ProbeRead = { kind: "ok"; bytes: Buffer } | { kind: "missing" } | { kind: "unreadable" };

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

/** Read a probe file without following symlinks, capped at `maxBytes`. */
export async function readProbeFile(abs: string, maxBytes: number): Promise<ProbeRead> {
  let handle;
  try {
    handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    // ELOOP (final component is a symlink) and every other open failure fail
    // closed; only a genuinely absent file is "missing".
    return { kind: isMissing(error) ? "missing" : "unreadable" };
  }
  try {
    const info = await handle.stat();
    // FIFOs and devices open fine under O_NONBLOCK but are not regular files;
    // an oversized regular file is rejected before a single byte is read.
    if (!info.isFile() || info.size > maxBytes) return { kind: "unreadable" };
    const buf = Buffer.alloc(info.size + 1);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await handle.read(buf, off, buf.length - off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    // Grew between fstat and read (or reports a size it does not honour).
    if (off > info.size || off > maxBytes) return { kind: "unreadable" };
    return { kind: "ok", bytes: buf.subarray(0, off) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Existence of a regular probe file, without opening it or following links. */
export async function probeFileExists(abs: string): Promise<boolean> {
  try {
    return (await lstat(abs)).isFile();
  } catch {
    return false;
  }
}

export type ProbeDir = { kind: "ok"; dir: string } | { kind: "missing" } | { kind: "unreadable" };

/**
 * The directory at `segments` under `root`, requiring every prefix to be a
 * real directory: a symlinked (or non-directory) prefix could lead probes
 * outside the workspace, so it is "unreadable" and the command stays local.
 */
export async function probeDir(root: string, segments: string[]): Promise<ProbeDir> {
  let dir = root;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    let info;
    try {
      info = await lstat(dir);
    } catch (error) {
      return { kind: isMissing(error) ? "missing" : "unreadable" };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return { kind: "unreadable" };
  }
  return { kind: "ok", dir };
}
