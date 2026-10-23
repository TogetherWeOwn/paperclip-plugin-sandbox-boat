import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, existsSync, utimesSync, chmodSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_POLICY,
  DEFAULT_SYNC_EXCLUDES,
  LocalGuestStore,
  SyncError,
  buildRsyncPushArgs,
  captureManifest,
  captureSnapshot,
  collectAndStage,
  isReturnEligible,
  planPush,
  renderFilesFromList,
} from "./offload-sync.js";

function makeTemp(): string {
  return mkdtempSync(path.join(tmpdir(), "offload-sync-"));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function liveHashes(root: string, rels: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of rels) {
    const abs = path.join(root, rel);
    out[rel] = existsSync(abs) && lstatSync(abs).isFile() ? sha256File(abs) : null;
  }
  return out;
}

describe("captureManifest", () => {
  it("captures content hashes, modes and mtimes for eligible source files", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "fn main() {}\n", "Cargo.toml": "[package]\n" });
    const { manifest, stats } = await captureManifest(root);
    expect(manifest.version).toBe(1);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(["Cargo.toml", "src/main.rs"]);
    const main = manifest.files.find((f) => f.path === "src/main.rs")!;
    expect(main.sha256).toBe(sha256File(path.join(root, "src/main.rs")));
    expect(main.size).toBe("fn main() {}\n".length);
    expect(main.mtimeMs).toBeGreaterThan(0);
    expect(main.mode & 0o777).toBe(lstatSync(path.join(root, "src/main.rs")).mode & 0o777);
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("excludes build caches, runtime dirs, secret files and private cargo config at any depth", async () => {
    const root = makeTemp();
    writeTree(root, {
      "src/main.rs": "fn main() {}\n",
      "target/debug/app": "binary\n",
      "crates/a/target/x": "nested cache\n",
      "node_modules/dep/index.js": "x\n",
      ".git/config": "git\n",
      ".paperclip-runtime/adapter/mcp-config": "JWT\n",
      ".claude/settings.json": "{}\n",
      ".cargo/config.toml": "token\n",
      ".env": "SECRET=1\n",
      ".env.local": "SECRET=2\n",
      "nested/.env.production": "SECRET=3\n",
      ".boat-offload/staged.json": "{}\n",
    });
    const { manifest } = await captureManifest(root);
    expect(manifest.files.map((f) => f.path)).toEqual(["src/main.rs"]);
    expect(DEFAULT_SYNC_EXCLUDES.length).toBeGreaterThan(0);
  });

  it("keeps in-root relative symlinks as links without following them", async () => {
    const root = makeTemp();
    writeTree(root, { "src/real.rs": "real\n" });
    symlinkSync("real.rs", path.join(root, "src/link.rs"));
    const { manifest } = await captureManifest(root);
    const link = manifest.files.find((f) => f.path === "src/link.rs")!;
    expect(link.symlink).toBe("real.rs");
    expect(link.sha256).not.toBe(sha256File(path.join(root, "src/real.rs")));
  });

  it("rejects symlinks that escape the source root instead of following them", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "x\n" });
    symlinkSync("../../outside.txt", path.join(root, "src/evil.rs"));
    await expect(captureManifest(root)).rejects.toMatchObject({ code: "SYNC_ESCAPING_SYMLINK" });
  });

  it("rejects absolute symlink targets, which cannot survive a guest mirror", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "x\n" });
    symlinkSync("/etc/hostname", path.join(root, "src/abs.rs"));
    await expect(captureManifest(root)).rejects.toMatchObject({ code: "SYNC_ESCAPING_SYMLINK" });
  });

  it("rejects special files instead of hashing a blocking device", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "x\n" });
    execFileSync("mkfifo", [path.join(root, "src/pipe")]);
    await expect(captureManifest(root)).rejects.toMatchObject({ code: "SYNC_SPECIAL_FILE" });
  });

  it("rejects excessive source trees instead of tarring an arbitrary home", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "fn main() {}\n", "src/lib.rs": "lib\n" });
    await expect(captureManifest(root, { maxBytes: 4 })).rejects.toMatchObject({ code: "SYNC_SOURCE_TOO_LARGE" });
    await expect(captureManifest(root, { maxFiles: 1 })).rejects.toMatchObject({ code: "SYNC_SOURCE_TOO_LARGE" });
    await expect(captureManifest(root, { maxFiles: 2 })).resolves.toBeTruthy();
  });

  it("retries capture once on a concurrent source edit, then reports never-started", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "v1\n" });
    let hashes = 0;
    // Mutate the file between the pre-read stat and the read on the first attempt only.
    const realOpen = fsp.open;
    const fs = {
      ...fsp,
      open: (async (p: string, flags: number) => {
        if (p === path.join(root, "src/main.rs") && hashes === 0) {
          hashes += 1;
          writeFileSync(p, "v2-mid-read\n");
        }
        return realOpen(p, flags);
      }) as typeof fsp.open,
    };
    // First attempt sees the edit and retries; retry captures v2 cleanly.
    const { manifest } = await captureManifest(root, { fs });
    expect(manifest.files.find((f) => f.path === "src/main.rs")!.sha256).toBe(sha256File(path.join(root, "src/main.rs")));

    // A file that changes on every read exhausts the single retry. Each write
    // grows the file, so detection never depends on mtime granularity.
    let n = 0;
    const alwaysMoving = {
      ...fsp,
      open: (async (p: string, flags: number) => {
        if (p === path.join(root, "src/main.rs")) {
          n += 1;
          writeFileSync(p, `v${n}\n${"x".repeat(n)}\n`);
        }
        return realOpen(p, flags);
      }) as typeof fsp.open,
    };
    await expect(captureManifest(root, { fs: alwaysMoving })).rejects.toMatchObject({ code: "SYNC_CONCURRENT_EDIT" });
  });
});

describe("captureSnapshot", () => {
  it("freezes an immutable copy that a later live symlink swap cannot poison", async () => {
    const root = makeTemp();
    const snapDir = makeTemp();
    writeTree(root, { "src/main.rs": "original\n" });
    const { manifest } = await captureSnapshot(root, snapDir);
    expect(readFileSync(path.join(snapDir, "src/main.rs"), "utf8")).toBe("original\n");
    // Swap the live file for an escaping symlink after capture: the snapshot still holds the bytes.
    rmSync(path.join(root, "src/main.rs"));
    symlinkSync("/etc/hostname", path.join(root, "src/main.rs"));
    expect(readFileSync(path.join(snapDir, "src/main.rs"), "utf8")).toBe("original\n");
    expect(manifest.files.find((f) => f.path === "src/main.rs")!.sha256).toBe(
      createHash("sha256").update("original\n").digest("hex"),
    );
  });

  it("retries once when a file changes between hashing and copying", async () => {
    const root = makeTemp();
    const snapDir = makeTemp();
    writeTree(root, { "src/main.rs": "v1\n" });
    let copies = 0;
    const realCopyFile = fsp.copyFile;
    const fs = {
      ...fsp,
      copyFile: (async (src: string, dest: string) => {
        if (src === path.join(root, "src/main.rs") && copies === 0) {
          copies += 1;
          writeFileSync(src, "v2\n");
        }
        return realCopyFile(src, dest);
      }) as typeof fsp.copyFile,
    };
    const { manifest } = await captureSnapshot(root, snapDir, { fs });
    // Retried capture picked up v2 and the snapshot matches the returned manifest.
    expect(manifest.files.find((f) => f.path === "src/main.rs")!.sha256).toBe(sha256File(path.join(snapDir, "src/main.rs")));
  });
});

describe("planPush", () => {
  it("plans zero files for an unchanged tree", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "x\n", "Cargo.toml": "y\n" });
    const before = (await captureManifest(root)).manifest;
    const after = (await captureManifest(root)).manifest;
    const plan = planPush(before, after);
    expect(plan.toSend).toEqual([]);
    expect(plan.toDeleteFromMirror).toEqual([]);
    expect(plan.bytesToSend).toBe(0);
  });

  it("plans exactly one file for one edit", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n", "src/b.rs": "b\n" });
    const before = (await captureManifest(root)).manifest;
    writeFileSync(path.join(root, "src/b.rs"), "b2\n");
    const after = (await captureManifest(root)).manifest;
    const plan = planPush(before, after);
    expect(plan.toSend.map((f) => f.path)).toEqual(["src/b.rs"]);
    expect(plan.bytesToSend).toBe("b2\n".length);
  });

  it("catches a same-size, same-mtime content edit by hash", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "aaaa\n" });
    const before = (await captureManifest(root)).manifest;
    const abs = path.join(root, "src/a.rs");
    const mtime = new Date(lstatSync(abs).mtimeMs);
    writeFileSync(abs, "bbbb\n"); // same size
    utimesSync(abs, mtime, mtime); // same mtime
    const after = (await captureManifest(root)).manifest;
    expect(after.files.find((f) => f.path === "src/a.rs")!.size).toBe(before.files.find((f) => f.path === "src/a.rs")!.size);
    expect(planPush(before, after).toSend.map((f) => f.path)).toEqual(["src/a.rs"]);
  });

  it("lists removed inputs for guest-mirror-only deletion", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n", "src/gone.rs": "gone\n" });
    const before = (await captureManifest(root)).manifest;
    rmSync(path.join(root, "src/gone.rs"));
    const after = (await captureManifest(root)).manifest;
    const plan = planPush(before, after);
    expect(plan.toSend).toEqual([]);
    expect(plan.toDeleteFromMirror).toEqual(["src/gone.rs"]);
  });

  it("sends the whole tree when there is no previous manifest", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n" });
    const snap = (await captureManifest(root)).manifest;
    expect(planPush(null, snap).toSend.map((f) => f.path)).toEqual(["src/a.rs"]);
  });
});

describe("LocalGuestStore.push", () => {
  it("transfers zero files for an unchanged tree and preserves mtimes and modes", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/main.rs": "x\n" });
    chmodSync(path.join(live, "src/main.rs"), 0o640);
    const store = new LocalGuestStore();
    const first = await captureSnapshot(live, snapDir);
    const sent = await store.push(snapDir, planPush(null, first.manifest).toSend, guest);
    expect(sent.files).toBe(1);
    // Second push of the identical tree: plan is empty, nothing transfers.
    const second = (await captureManifest(live)).manifest;
    const plan = planPush(first.manifest, second);
    expect(plan.toSend).toEqual([]);
    const noop = await store.push(snapDir, plan.toSend, guest);
    expect(noop).toMatchObject({ files: 0, bytes: 0 });
    // Mode and mtime survived the round trip, so cargo fingerprints hold.
    // Millisecond precision: the most Node's utimes can set (rsync keeps full precision).
    const srcStat = lstatSync(path.join(live, "src/main.rs"));
    const dstStat = lstatSync(path.join(guest, "src/main.rs"));
    expect(dstStat.mode & 0o777).toBe(srcStat.mode & 0o777);
    expect(Math.floor(dstStat.mtimeMs)).toBe(Math.floor(srcStat.mtimeMs));
  });

  it("transfers only the edited file on the next push", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/a.rs": "a\n", "src/b.rs": "b\n" });
    const store = new LocalGuestStore();
    const first = await captureSnapshot(live, snapDir);
    await store.push(snapDir, planPush(null, first.manifest).toSend, guest);
    writeFileSync(path.join(live, "src/b.rs"), "b2\n");
    const second = await captureSnapshot(live, snapDir);
    const again = await store.push(snapDir, planPush(first.manifest, second.manifest).toSend, guest);
    expect(again.files).toBe(1);
    expect(readFileSync(path.join(guest, "src/b.rs"), "utf8")).toBe("b2\n");
    expect(readFileSync(path.join(guest, "src/a.rs"), "utf8")).toBe("a\n");
  });

  it("recreates in-root symlinks as links in the mirror", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/real.rs": "real\n" });
    symlinkSync("real.rs", path.join(live, "src/link.rs"));
    const store = new LocalGuestStore();
    const snap = await captureSnapshot(live, snapDir);
    await store.push(snapDir, planPush(null, snap.manifest).toSend, guest);
    expect(lstatSync(path.join(guest, "src/link.rs")).isSymbolicLink()).toBe(true);
  });

  it("refuses to write outside the guest mirror", async () => {
    const snapDir = makeTemp();
    const guest = makeTemp();
    const store = new LocalGuestStore();
    await expect(
      store.push(snapDir, [{ path: "../escape.txt", size: 1, mtimeMs: 1, mode: 0o644, sha256: "x" }], guest),
    ).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
  });

  it("recovers a partial transfer by sending only what is missing", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "a.rs": "a\n", "b.rs": "b\n", "c.rs": "c\n" });
    const snap = await captureSnapshot(live, snapDir);
    const plan = planPush(null, snap.manifest);
    let calls = 0;
    const flaky = new LocalGuestStore({
      beforeCopy: () => {
        calls += 1;
        if (calls === 2) throw new Error("simulated transport failure");
      },
    });
    await expect(flaky.push(snapDir, plan.toSend, guest)).rejects.toThrow("simulated transport failure");
    const steady = new LocalGuestStore();
    const resumed = await steady.push(snapDir, plan.toSend, guest);
    // One file landed before the failure; the retry skips it by hash and sends the rest.
    expect(resumed.skipped).toBe(1);
    expect(resumed.files).toBe(2);
    expect(readFileSync(path.join(guest, "a.rs"), "utf8")).toBe("a\n");
    expect(readFileSync(path.join(guest, "b.rs"), "utf8")).toBe("b\n");
    expect(readFileSync(path.join(guest, "c.rs"), "utf8")).toBe("c\n");
  });
});

describe("LocalGuestStore.pruneMirror", () => {
  it("removes obsolete inputs only from the guest mirror, never host files or guest caches", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/keep.rs": "k\n" });
    writeTree(guest, { "src/keep.rs": "k\n", "src/gone.rs": "old\n", "target/debug/app": "cache\n" });
    const store = new LocalGuestStore();
    const pruned = await store.pruneMirror(guest, ["src/gone.rs"]);
    expect(pruned.removed).toBe(1);
    expect(existsSync(path.join(guest, "src/gone.rs"))).toBe(false);
    expect(existsSync(path.join(guest, "src/keep.rs"))).toBe(true);
    expect(existsSync(path.join(guest, "target/debug/app"))).toBe(true);
    expect(existsSync(path.join(live, "src/keep.rs"))).toBe(true);
  });

  it("refuses traversal deletes against the guest parent", async () => {
    const guest = makeTemp();
    const store = new LocalGuestStore();
    await expect(store.pruneMirror(guest, ["../x"])).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
  });
});

describe("isReturnEligible", () => {
  it("returns Cargo.lock and snapshots with an empty generated allowlist by default", () => {
    expect(DEFAULT_RETURN_POLICY).toEqual({ generatedAllowlist: [] });
    expect(isReturnEligible("Cargo.lock", DEFAULT_RETURN_POLICY)).toBe(true);
    expect(isReturnEligible("tests/e2e.snap", DEFAULT_RETURN_POLICY)).toBe(true);
    expect(isReturnEligible("tests/e2e.snap.new", DEFAULT_RETURN_POLICY)).toBe(true);
    expect(isReturnEligible("snapshot.snap", DEFAULT_RETURN_POLICY)).toBe(true);
    expect(isReturnEligible("src/main.rs", DEFAULT_RETURN_POLICY)).toBe(false);
    expect(isReturnEligible("nested/Cargo.lock", DEFAULT_RETURN_POLICY)).toBe(false);
    expect(isReturnEligible("target/debug/app", DEFAULT_RETURN_POLICY)).toBe(false);
  });

  it("honors a server-owned generated-path allowlist with globs", () => {
    const policy = { generatedAllowlist: ["src/generated/**", "bindings.json"] };
    expect(isReturnEligible("src/generated/x.rs", policy)).toBe(true);
    expect(isReturnEligible("bindings.json", policy)).toBe(true);
    expect(isReturnEligible("src/main.rs", policy)).toBe(false);
  });
});

describe("collectAndStage", () => {
  it("returns a changed Cargo.lock to staging without touching the live tree", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-1");
    writeTree(live, { "Cargo.lock": "v1\n", "src/main.rs": "x\n" });
    writeTree(guest, { "Cargo.lock": "v1\n", "src/main.rs": "x\n" });
    const before = liveHashes(live, ["Cargo.lock", "src/main.rs"]);
    const uploaded = (await captureManifest(live)).manifest;
    // The guest command resolved new dependencies.
    writeFileSync(path.join(guest, "Cargo.lock"), "v1\n# new-dep\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.changedPaths).toEqual(["Cargo.lock"]);
    expect(result.conflictPaths).toEqual([]);
    expect(result.artifactDir).toBe(staging);
    const staged = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(staged.op).toBe("modify");
    expect(staged.supported).toBe(true);
    expect(readFileSync(path.join(staging, staged.stagedRelPath!), "utf8")).toBe("v1\n# new-dep\n");
    expect(staged.baselineSha256).toBe(createHash("sha256").update("v1\n").digest("hex"));
    expect(staged.liveSha256).toBe(createHash("sha256").update("v1\n").digest("hex"));
    // Live files are byte-identical: V1 never applies, even with an unchanged baseline.
    expect(liveHashes(live, ["Cargo.lock", "src/main.rs"])).toEqual(before);
  });

  it("stages new snapshot files and reports a clean tree as clean", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/main.rs": "x\n" });
    writeTree(guest, { "src/main.rs": "x\n" });
    const uploaded = (await captureManifest(live)).manifest;
    const clean = await collectAndStage({
      liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: path.join(makeTemp(), "cmd-clean"),
    });
    expect(clean.state).toBe("clean");
    expect(clean.changedPaths).toEqual([]);
    expect(clean.artifactDir).toBeNull();
    // Now the guest test run writes new snapshots.
    writeTree(guest, { "tests/e2e.snap.new": "snap\n", "tests/e2e.snap": "old\n" });
    writeTree(live, { "tests/e2e.snap": "old\n" });
    const uploaded2 = (await captureManifest(live)).manifest;
    const staging = path.join(makeTemp(), "cmd-2");
    const result = await collectAndStage({ liveRoot: live, uploaded: uploaded2, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.changedPaths.sort()).toEqual(["tests/e2e.snap.new"]);
    expect(result.changes.find((c) => c.path === "tests/e2e.snap.new")!.op).toBe("create");
  });

  it("keeps a conflicting local edit and reports both versions", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-3");
    writeTree(live, { "Cargo.lock": "v1\n" });
    const uploaded = (await captureManifest(live)).manifest;
    writeTree(guest, { "Cargo.lock": "v1\n" });
    // Both sides edited after the push: the guest resolved deps, the human pinned one locally.
    writeFileSync(path.join(guest, "Cargo.lock"), "v1\n# guest-dep\n");
    writeFileSync(path.join(live, "Cargo.lock"), "v1\n# local-pin\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("conflict");
    expect(result.changedPaths).toEqual(["Cargo.lock"]);
    expect(result.conflictPaths).toEqual(["Cargo.lock"]);
    const staged = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(staged.liveSha256).toBe(createHash("sha256").update("v1\n# local-pin\n").digest("hex"));
    expect(readFileSync(path.join(staging, staged.stagedRelPath!), "utf8")).toBe("v1\n# guest-dep\n");
    // The divergent local edit is preserved byte for byte.
    expect(readFileSync(path.join(live, "Cargo.lock"), "utf8")).toBe("v1\n# local-pin\n");
  });

  it("collects permitted writes even when the command failed (exit-agnostic)", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-4");
    writeTree(live, { "Cargo.lock": "v1\n" });
    const uploaded = (await captureManifest(live)).manifest;
    writeTree(guest, { "Cargo.lock": "v1\n# partial\n" });
    // No exit code is consulted: collection compares the guest against the uploaded manifest.
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.changedPaths).toEqual(["Cargo.lock"]);
  });

  it("stages everything and never applies, even when a mutation lease token is supplied", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-5");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": "v1\n# guest\n" });
    const uploaded = (await captureManifest(live)).manifest;
    const result = await collectAndStage({
      liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging,
      mutationLease: { token: "lease-123", holder: "test" },
    });
    expect(result.state).toBe("staged");
    expect(readFileSync(path.join(live, "Cargo.lock"), "utf8")).toBe("v1\n");
  });

  it("reports unsupported source writes separately while retaining them bounded", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-6");
    writeTree(live, { "src/main.rs": "x\n", "Cargo.lock": "v1\n" });
    writeTree(guest, { "src/main.rs": "x\n", "Cargo.lock": "v1\n" });
    const uploaded = (await captureManifest(live)).manifest;
    // A build script rewrote a source file: not in the return set.
    writeFileSync(path.join(guest, "src/main.rs"), "generated\n");
    writeFileSync(path.join(guest, "Cargo.lock"), "v1\n# ok\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.unsupportedPaths).toEqual(["src/main.rs"]);
    expect(result.changedPaths.sort()).toEqual(["Cargo.lock", "src/main.rs"]);
    const unsupported = result.changes.find((c) => c.path === "src/main.rs")!;
    expect(unsupported.supported).toBe(false);
    expect(readFileSync(path.join(staging, unsupported.stagedRelPath!), "utf8")).toBe("generated\n");
    expect(readFileSync(path.join(live, "src/main.rs"), "utf8")).toBe("x\n");
  });

  it("represents a remote deletion as a proposal and never deletes local data", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-7");
    writeTree(live, { "src/old.rs": "old\n" });
    writeTree(guest, { "src/old.rs": "old\n" });
    const uploaded = (await captureManifest(live)).manifest;
    rmSync(path.join(guest, "src/old.rs"));
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    const change = result.changes.find((c) => c.path === "src/old.rs")!;
    expect(change.op).toBe("proposed-delete");
    expect(change.returnedSha256).toBeNull();
    expect(change.stagedRelPath).toBeNull();
    expect(result.state).toBe("staged");
    expect(readFileSync(path.join(live, "src/old.rs"), "utf8")).toBe("old\n");
  });

  it("ignores guest build caches and never copies compilation outputs back", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/main.rs": "x\n" });
    writeTree(guest, { "src/main.rs": "x\n" });
    const uploaded = (await captureManifest(live)).manifest;
    writeTree(guest, { "target/debug/app": "huge-binary\n", "node_modules/x/index.js": "dep\n" });
    const result = await collectAndStage({
      liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: path.join(makeTemp(), "cmd-8"),
    });
    expect(result.state).toBe("clean");
  });

  it("tolerates a live file deleted between push and staging and reports a conflict", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-9");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": "v1\n# guest\n" });
    const uploaded = (await captureManifest(live)).manifest;
    rmSync(path.join(live, "Cargo.lock"));
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("conflict");
    expect(result.conflictPaths).toEqual(["Cargo.lock"]);
    expect(result.changes.find((c) => c.path === "Cargo.lock")!.liveSha256).toBeNull();
    expect(existsSync(path.join(live, "Cargo.lock"))).toBe(false);
  });

  it("never follows a guest-planted escaping symlink and stages no bytes for it", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-10");
    writeTree(live, { "src/main.rs": "x\n" });
    writeTree(guest, { "src/main.rs": "x\n" });
    const uploaded = (await captureManifest(live)).manifest;
    symlinkSync("/etc/hostname", path.join(guest, "evil.snap"));
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    const change = result.changes.find((c) => c.path === "evil.snap")!;
    expect(change.supported).toBe(false);
    expect(change.stagedRelPath).toBeNull();
    expect(result.unsupportedPaths).toContain("evil.snap");
    expect(existsSync(path.join(live, "evil.snap"))).toBe(false);
  });

  it("fails closed when staged bytes exceed the cap, keeping metadata for every change", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-11");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": `v1\n${"x".repeat(100)}\n` });
    const uploaded = (await captureManifest(live)).manifest;
    const result = await collectAndStage({
      liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging, maxStagedBytes: 8,
    });
    expect(result.truncated).toBe(true);
    expect(result.state).toBe("staged");
    const change = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(change.stagedRelPath).toBeNull();
    expect(change.returnedSha256).not.toBeNull();
  });

  it("writes a manifest.json describing every staged change for explicit application", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-12");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": "v1\n# g\n" });
    const uploaded = (await captureManifest(live)).manifest;
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.artifactDir).toBe(staging);
    const doc = JSON.parse(readFileSync(path.join(staging, "manifest.json"), "utf8"));
    expect(doc.state).toBe("staged");
    expect(doc.changedPaths).toEqual(["Cargo.lock"]);
    expect(doc.changes).toHaveLength(1);
    expect(doc.changes[0]).toMatchObject({ path: "Cargo.lock", op: "modify", supported: true });
  });
});

describe("rsync transport spec", () => {
  it("builds a pinned-SSH delta push that preserves times and modes and never deletes", async () => {
    const args = buildRsyncPushArgs(
      {
        controlPath: "/tmp/pcboat/abc.ctl",
        user: "user",
        host: "10.0.0.9",
        port: 2222,
        privateKeyPath: "/tmp/pcboat/id_ed25519",
        knownHostsPath: "/tmp/pcboat/known_hosts_abc",
        hostKeyAlias: "sandbox-abc",
        connectTimeoutSec: 10,
      },
      "/tmp/snap",
      "/home/user/card-1",
      ["src/b.rs", "Cargo.toml"],
    );
    const joined = args.join(" ");
    expect(joined).toContain("--times");
    expect(joined).toContain("--perms");
    expect(joined).toContain("--files-from=");
    expect(joined).toContain("--from0");
    expect(joined).not.toContain("--delete");
    expect(joined).toContain("ControlPath=/tmp/pcboat/abc.ctl");
    expect(joined).toContain("ControlMaster=no");
    expect(joined).toContain("HostKeyAlias=sandbox-abc");
    expect(joined).toContain("user@10.0.0.9:/home/user/card-1");
    for (const exclude of ["target/", ".git/", "node_modules/", ".paperclip-runtime/", ".env"]) {
      expect(joined).toContain(exclude);
    }
  });

  it("renders the delta file list null-separated so odd names cannot smuggle flags", () => {
    const out = renderFilesFromList([{ path: "src/b.rs" } as never, { path: "--delete" } as never]);
    expect(out).toBe("src/b.rs\0--delete\0");
  });
});

describe("SyncError", () => {
  it("carries a machine-readable code", () => {
    expect(new SyncError("SYNC_TRAVERSAL", "nope").code).toBe("SYNC_TRAVERSAL");
  });
});
