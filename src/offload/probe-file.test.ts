import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nestedLockfile, planDependencies } from "./deps-install.js";
import { probeDir, probeFileExists, readProbeFile } from "./probe-file.js";
import { classifyCargoWorkspace, V1_PROFILE } from "./routes.js";
import { readToolchainPin } from "./toolchain-file.js";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "boat-probe-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Sparse file of `size` bytes outside every workspace under test. */
function outsideSparse(size: number): string {
  const dir = workspace();
  const file = path.join(dir, "outside.bin");
  writeFileSync(file, "");
  truncateSync(file, size);
  return file;
}

describe("readProbeFile", () => {
  it("reads a small regular file, reports missing, and caps size before reading", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "ok.txt"), "hello");
    await expect(readProbeFile(path.join(root, "ok.txt"), 16)).resolves.toMatchObject({ kind: "ok" });
    await expect(readProbeFile(path.join(root, "absent.txt"), 16)).resolves.toEqual({ kind: "missing" });
    writeFileSync(path.join(root, "big.txt"), "x".repeat(64));
    await expect(readProbeFile(path.join(root, "big.txt"), 16)).resolves.toEqual({ kind: "unreadable" });
  });

  it("never follows a symlink, not even to a small in-root file", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "target.txt"), "stable");
    symlinkSync(path.join(root, "target.txt"), path.join(root, "link.txt"));
    await expect(readProbeFile(path.join(root, "link.txt"), 16)).resolves.toEqual({ kind: "unreadable" });
    symlinkSync("/dev/zero", path.join(root, "zero.txt"));
    await expect(readProbeFile(path.join(root, "zero.txt"), 16)).resolves.toEqual({ kind: "unreadable" });
  });

  it("rejects a FIFO without blocking", async () => {
    const root = workspace();
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await expect(readProbeFile(path.join(root, "pipe"), 16)).resolves.toEqual({ kind: "unreadable" });
  });
});

describe("probeDir / probeFileExists", () => {
  it("accepts real directories and rejects symlinked prefixes", async () => {
    const root = workspace();
    mkdirSync(path.join(root, "real", "sub"), { recursive: true });
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    await expect(probeDir(root, ["real", "sub"])).resolves.toMatchObject({ kind: "ok" });
    await expect(probeDir(root, ["link", "sub"])).resolves.toEqual({ kind: "unreadable" });
    await expect(probeDir(root, ["gone"])).resolves.toEqual({ kind: "missing" });
    writeFileSync(path.join(root, "real", "package-lock.json"), "{}");
    await expect(probeFileExists(path.join(root, "real", "package-lock.json"))).resolves.toBe(true);
    symlinkSync(path.join(root, "real", "package-lock.json"), path.join(root, "lock-link.json"));
    await expect(probeFileExists(path.join(root, "lock-link.json"))).resolves.toBe(false);
  });
});

describe("toolchain pin probe (host safety)", () => {
  async function expectFastLocal(root: string, cwdRelative = ".") {
    const started = Date.now();
    const result = await classifyCargoWorkspace(V1_PROFILE, ["check"], root, cwdRelative);
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.mode).toBe("local");
    expect(result.reason).toContain("unreadable");
    return result;
  }

  it("rust-toolchain -> /dev/zero stays local instead of exhausting memory", async () => {
    const root = workspace();
    symlinkSync("/dev/zero", path.join(root, "rust-toolchain"));
    const heapBefore = process.memoryUsage().heapUsed;
    await expect(readToolchainPin(root)).resolves.toEqual({ kind: "unreadable", file: "rust-toolchain" });
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(8 * 1024 * 1024);
    await expectFastLocal(root);
  });

  it("a FIFO toolchain file stays local instead of blocking", async () => {
    const root = workspace();
    execFileSync("mkfifo", [path.join(root, "rust-toolchain")]);
    await expectFastLocal(root);
  });

  it("a symlinked run directory leading outside the root stays local", async () => {
    const root = workspace();
    const outside = workspace();
    // Even a pin the profile installs must not be read through the link.
    writeFileSync(path.join(outside, "rust-toolchain"), V1_PROFILE.toolchains[0]!);
    symlinkSync(outside, path.join(root, "link"));
    await expectFastLocal(root, "link");
  });

  it("never echoes content read through a symlink into the local reason", async () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(path.join(outside, "secret"), "sk-SECRET");
    symlinkSync(path.join(outside, "secret"), path.join(root, "rust-toolchain"));
    const result = await expectFastLocal(root);
    expect(result.reason).not.toContain("sk-SECRET");
  });

  it("an oversized regular toolchain file is unreadable without being buffered whole", async () => {
    const root = workspace();
    const big = path.join(root, "rust-toolchain");
    writeFileSync(big, "");
    truncateSync(big, 1024 * 1024);
    await expectFastLocal(root);
  });
});

describe("lockfile probes (host safety)", () => {
  it("package-lock.json -> 100 MiB sparse file outside the root plans nothing, heap flat", async () => {
    const root = workspace();
    symlinkSync(outsideSparse(100 * 1024 * 1024), path.join(root, "package-lock.json"));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    await expect(planDependencies(root, "node")).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(8 * 1024 * 1024);
  });

  it("an oversized regular lockfile stays local", async () => {
    const root = workspace();
    const big = path.join(root, "package-lock.json");
    writeFileSync(big, "");
    truncateSync(big, 33 * 1024 * 1024);
    await expect(planDependencies(root, "node")).resolves.toBeNull();
  });

  it("nestedLockfile detects a nested lockfile without opening it", async () => {
    const root = workspace();
    mkdirSync(path.join(root, "sub"), { recursive: true });
    const lockfile = path.join(root, "sub", "package-lock.json");
    writeFileSync(lockfile, "{}");
    chmodSync(lockfile, 0o000); // a read would fail for a non-root worker
    await expect(nestedLockfile(root, "sub", "node")).resolves.toBe("sub/package-lock.json");
  });

  it("nestedLockfile fails closed on a symlinked run directory", async () => {
    const root = workspace();
    symlinkSync(workspace(), path.join(root, "link"));
    await expect(nestedLockfile(root, "link", "node")).resolves.toBe("link");
  });

  it("a symlinked lockfile at the root does not shadow a real one in the other ecosystem", async () => {
    const root = workspace();
    symlinkSync("/dev/zero", path.join(root, "package-lock.json"));
    writeFileSync(path.join(root, "uv.lock"), "version = 1\n");
    await expect(planDependencies(root, "python")).resolves.toMatchObject({ installs: [{ lockfile: "uv.lock" }] });
  });
});
