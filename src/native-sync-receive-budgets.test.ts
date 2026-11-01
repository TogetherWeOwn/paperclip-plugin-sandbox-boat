// The confined (host) tar receiver is the one place guest-produced bytes land
// on the host, so it must be bounded by member type, total bytes, entry count
// and free disk — and must remove the partial tree when it refuses. Every
// archive here is synthetic and streamed to the receiver's stdin; nothing is
// stored on disk first.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_SYNC_SCRIPT } from "./file-sync-script.js";

const scratchBase = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
let root: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(scratchBase, "receive-budgets-"));
  target = path.join(root, "target");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function header(entry: { name: string; type?: string; mode?: number; size?: number; link?: string }): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name.slice(0, 100), 0, 100, "utf8");
  block.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${(entry.size ?? 0).toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(32, 148, 156);
  block[156] = (entry.type ?? "0").charCodeAt(0);
  if (entry.link) block.write(entry.link, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function member(entry: { name: string; type?: string; mode?: number; body?: Buffer; link?: string }): Buffer {
  const blocks: Buffer[] = [];
  if (Buffer.byteLength(entry.name) > 100) {
    const longName = Buffer.from(`${entry.name}\0`);
    blocks.push(header({ name: "././@LongLink", type: "L", size: longName.length }), longName,
      Buffer.alloc((512 - longName.length % 512) % 512));
  }
  const body = entry.body ?? Buffer.alloc(0);
  blocks.push(header({ ...entry, size: body.length }), body, Buffer.alloc((512 - body.length % 512) % 512));
  return Buffer.concat(blocks);
}

const END = Buffer.alloc(1024);

function receive(limits: Record<string, number>): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
  const mapping = JSON.stringify({
    sourcePath: path.join(root, "source"), targetPath: target, kind: "directory",
    diskReserveBytes: 0, ...limits,
  });
  const child = spawn("python3", ["-I", "-c", FILE_SYNC_SCRIPT, "receive", mapping, "confined"],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stdout!.resume();
  child.stderr!.on("data", (bytes) => { stderr += String(bytes); });
  child.stdin!.on("error", () => {});
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

async function run(limits: Record<string, number>, archive: Buffer) {
  const { child, done } = receive(limits);
  child.stdin!.end(archive);
  return done;
}

describe("confined tar receiver budgets", () => {
  it("rejects a GNU sparse member at its first header without buffering extended blocks", async () => {
    // The wrapper streams one 'S' header (isextended=1) plus 100k extended
    // sparse blocks (51 MiB, generated in memory, never stored) and reports
    // the receiver's peak RSS through RUSAGE_CHILDREN.
    const wrapper = String.raw`
import json, resource, subprocess, sys
def sparse_header():
    block = bytearray(512)
    block[0:6] = b"sparse"
    block[100:108] = b"0000644\0"; block[108:116] = b"0000000\0"; block[116:124] = b"0000000\0"
    block[124:136] = b"00000000000\0"; block[136:148] = b"00000000000\0"
    block[148:156] = b"        "; block[156:157] = b"S"
    block[257:265] = b"ustar  \0"
    for i in range(4):
        off = 386 + i * 24
        block[off:off + 12] = b"00000000001\0"; block[off + 12:off + 24] = b"00000000001\0"
    block[482:483] = b"1"; block[483:495] = b"00000000001\0"
    block[148:156] = ("%06o\0 " % sum(block)).encode()
    return bytes(block)
def extended_block():
    block = bytearray(512)
    for i in range(21):
        off = i * 24
        block[off:off + 12] = b"00000000001\0"; block[off + 12:off + 24] = b"00000000001\0"
    block[504:505] = b"1"
    return bytes(block)
# Stream the blocks instead of building one payload: a 51 MiB bytes object in
# this wrapper would be counted in the forked child's peak RSS before exec.
proc = subprocess.Popen([sys.executable, "-I", "-c", sys.argv[1], "receive", sys.argv[2], "confined"],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    proc.stdin.write(sparse_header())
    block = extended_block()
    for _ in range(100000):
        proc.stdin.write(block)
    proc.stdin.close()
except BrokenPipeError:
    pass
stderr = proc.stderr.read()
proc.wait(timeout=60)
print(json.dumps({"code": proc.returncode, "stderr": stderr.decode("utf8", "replace")[-500:],
                  "maxrssKiB": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))
`;
    const mapping = JSON.stringify({ sourcePath: path.join(root, "source"), targetPath: target, kind: "directory", diskReserveBytes: 0 });
    const child = spawn("python3", ["-I", "-c", wrapper, FILE_SYNC_SCRIPT, mapping], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes) => { stdout += String(bytes); });
    child.stderr.on("data", (bytes) => { stderr += String(bytes); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as { code: number; stderr: string; maxrssKiB: number };
    expect(report.code).not.toBe(0);
    expect(report.stderr).toContain("unsupported tar member");
    expect(report.stderr).not.toContain("sparse tar entries are unsupported");
    expect(report.maxrssKiB).toBeLessThan(64 * 1024);
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it("refuses a 2 GiB member at a 64 MiB byte budget before writing it, and removes the target", async () => {
    const { child, done } = receive({ maxBytes: 64 * 1024 * 1024 });
    let written = 0;
    let closed = false;
    void done.then(() => { closed = true; }, () => { closed = true; });
    const zeros = Buffer.alloc(1024 * 1024);
    child.stdin!.write(header({ name: "big", size: 2 * 1024 * 1024 * 1024 }));
    // Stream /dev/zero-equivalent bytes with backpressure until the receiver
    // exits; it must refuse at the header, long before the 2 GiB body is sent.
    const pump = (async () => {
      while (!closed && written < 512 * 1024 * 1024) {
        written += zeros.length;
        if (!child.stdin!.write(zeros)) {
          await Promise.race([once(child.stdin!, "drain").catch(() => {}), done.catch(() => {})]);
        }
      }
    })();
    try {
      const { code, stderr } = await done;
      expect(code).not.toBe(0);
      expect(stderr).toContain("tar byte budget exceeded");
      expect(written).toBeLessThan(512 * 1024 * 1024);
      expect(existsSync(target)).toBe(false);
    } finally {
      child.stdin!.destroy();
      await pump.catch(() => {});
    }
  }, 30_000);

  it("refuses an archive past the entry budget and removes the partial tree", async () => {
    const files: Buffer[] = [];
    for (let i = 0; i < 5000; i++) files.push(member({ name: `f${i}`, body: Buffer.from("x") }));
    const { code, stderr } = await run({ maxFiles: 1000, maxBytes: 1024 * 1024 * 1024 },
      Buffer.concat([...files, END]));
    expect(code).not.toBe(0);
    expect(stderr).toContain("tar entry budget exceeded");
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it("refuses a member that would breach the disk reserve", async () => {
    const { code, stderr } = await run({ diskReserveBytes: 2 ** 50 },
      Buffer.concat([member({ name: "x", body: Buffer.from("x") }), END]));
    expect(code).not.toBe(0);
    expect(stderr).toContain("tar disk reserve would be breached");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a directory member that would breach the disk reserve", async () => {
    const { code, stderr } = await run({ diskReserveBytes: 2 ** 50 },
      Buffer.concat([member({ name: "sub", type: "5" }), END]));
    expect(code).not.toBe(0);
    expect(stderr).toContain("tar disk reserve would be breached");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a symlink member that would breach the disk reserve", async () => {
    const { code, stderr } = await run({ diskReserveBytes: 2 ** 50 },
      Buffer.concat([member({ name: "link", type: "2", link: "x" }), END]));
    expect(code).not.toBe(0);
    expect(stderr).toContain("tar disk reserve would be breached");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects unbounded trailing data after the tar end marker and removes the target", async () => {
    const archive = Buffer.concat([
      member({ name: "x", body: Buffer.from("x") }),
      END,
      Buffer.alloc(4 * 1024 * 1024, 1),
    ]);
    const { code, stderr } = await run({}, archive);
    expect(code).not.toBe(0);
    expect(stderr).toContain("trailing data after tar end marker exceeds limit");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a member path deeper than 256 components", async () => {
    const deep = Array.from({ length: 257 }, () => "a").join("/");
    const { code, stderr } = await run({}, Buffer.concat([member({ name: deep, body: Buffer.from("x") }), END]));
    expect(code).not.toBe(0);
    expect(stderr).toContain("tar member path exceeds depth limit");
    expect(existsSync(target)).toBe(false);
  });

  it("forces owner-rwx on guest-chosen directory modes so the tree stays deletable", async () => {
    const archive = Buffer.concat([
      member({ name: ".", type: "5", mode: 0 }),
      member({ name: "sub", type: "5", mode: 0 }),
      member({ name: "sub/file", body: Buffer.from("hi") }),
      END,
    ]);
    const { code, stderr } = await run({}, archive);
    expect(code, stderr).toBe(0);
    for (const dir of [target, path.join(target, "sub")]) {
      expect((await stat(dir)).mode & 0o700).toBe(0o700);
    }
    await rm(target, { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
  });
});
