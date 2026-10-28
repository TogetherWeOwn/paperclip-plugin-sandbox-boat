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
  collectStreamCapped,
  isReturnEligible,
  planPush,
  renderFilesFromList,
  resolveContained,
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

  it("never syncs registry credential files", async () => {
    const root = makeTemp();
    writeTree(root, {
      "src/main.rs": "fn main() {}\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=secret\n",
      ".yarnrc": "registry-token\n",
      ".yarnrc.yml": "npmAuthToken: secret\n",
      ".pypirc": "[pypi]\npassword=secret\n",
      "pip.conf": "[global]\npassword=secret\n",
      ".netrc": "machine example.com password secret\n",
      "nested/.npmrc": "//private/:_authToken=secret\n",
    });
    const { manifest } = await captureManifest(root);
    expect(manifest.files.map((f) => f.path)).toEqual(["src/main.rs"]);
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
  it("returns package lockfiles at the root alongside Cargo.lock and snapshots", () => {
    for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "uv.lock"]) {
      expect(isReturnEligible(lock, DEFAULT_RETURN_POLICY)).toBe(true);
      expect(isReturnEligible(`nested/${lock}`, DEFAULT_RETURN_POLICY)).toBe(false);
    }
  });

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

describe("collectAndStage live non-regular paths", () => {
  it("reports a conflict when the guest deletes a file the live tree replaced with a directory", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-nonreg-del");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": "v1\n" });
    const uploaded = (await captureManifest(live)).manifest;
    // The guest command deleted the file; meanwhile the live tree replaced it with a directory.
    rmSync(path.join(guest, "Cargo.lock"));
    rmSync(path.join(live, "Cargo.lock"));
    mkdirSync(path.join(live, "Cargo.lock"));
    writeFileSync(path.join(live, "Cargo.lock", "keep.txt"), "local\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("conflict");
    expect(result.conflictPaths).toEqual(["Cargo.lock"]);
    const change = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(change.op).toBe("proposed-delete");
    expect(change.liveSha256).toBe("non-regular");
    expect(change.returnedSha256).toBeNull();
    expect(change.stagedRelPath).toBeNull();
    // Both versions preserved: the live directory is untouched.
    expect(lstatSync(path.join(live, "Cargo.lock")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(live, "Cargo.lock", "keep.txt"), "utf8")).toBe("local\n");
  });

  it("reports a conflict when the guest creates a file where the live tree holds a directory", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-nonreg-create");
    writeTree(live, { "src/main.rs": "x\n" });
    writeTree(guest, { "src/main.rs": "x\n" });
    const uploaded = (await captureManifest(live)).manifest;
    // After the push the live tree grew a directory where the guest wrote a new snapshot file.
    mkdirSync(path.join(live, "new.snap"));
    writeFileSync(path.join(live, "new.snap", "keep.txt"), "local\n");
    writeFileSync(path.join(guest, "new.snap"), "snap\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("conflict");
    expect(result.changedPaths).toEqual(["new.snap"]);
    expect(result.conflictPaths).toEqual(["new.snap"]);
    const change = result.changes.find((c) => c.path === "new.snap")!;
    expect(change.op).toBe("create");
    expect(change.supported).toBe(true);
    expect(change.liveSha256).toBe("non-regular");
    expect(readFileSync(path.join(staging, change.stagedRelPath!), "utf8")).toBe("snap\n");
    expect(lstatSync(path.join(live, "new.snap")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(live, "new.snap", "keep.txt"), "utf8")).toBe("local\n");
  });

  it("treats a convergent delete as staged with a null live hash", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-convergent-del");
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guest, { "Cargo.lock": "v1\n" });
    const uploaded = (await captureManifest(live)).manifest;
    rmSync(path.join(guest, "Cargo.lock"));
    rmSync(path.join(live, "Cargo.lock"));
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.conflictPaths).toEqual([]);
    const change = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(change.op).toBe("proposed-delete");
    expect(change.liveSha256).toBeNull();
  });

  it("treats a clean create over an absent live path as staged with a null live hash", async () => {
    const live = makeTemp();
    const guest = makeTemp();
    const staging = path.join(makeTemp(), "cmd-clean-create");
    writeTree(live, { "src/main.rs": "x\n" });
    writeTree(guest, { "src/main.rs": "x\n" });
    const uploaded = (await captureManifest(live)).manifest;
    writeFileSync(path.join(guest, "new.snap"), "snap\n");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: staging });
    expect(result.state).toBe("staged");
    expect(result.conflictPaths).toEqual([]);
    const change = result.changes.find((c) => c.path === "new.snap")!;
    expect(change.op).toBe("create");
    expect(change.liveSha256).toBeNull();
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
    expect(joined).toContain("ForwardAgent=no");
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

function raceErr(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code} race`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("captureManifest structural races", () => {
  it("retries when a file vanishes between readdir and lstat", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n", "src/b.rs": "b\n" });
    let calls = 0;
    const realLstat = fsp.lstat;
    const fs = {
      ...fsp,
      lstat: (async (p: string) => {
        calls += 1;
        if (calls === 1) throw raceErr("ENOENT");
        return realLstat(p);
      }) as typeof fsp.lstat,
    };
    const { manifest } = await captureManifest(root, { fs });
    expect(manifest.files.map((f) => f.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
  });

  it("retries when a directory vanishes between stack push and readdir", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n" });
    let calls = 0;
    const realReaddir = fsp.readdir;
    const fs = {
      ...fsp,
      readdir: (async (p: string, opts: { withFileTypes: true }) => {
        calls += 1;
        if (calls === 2) throw raceErr("ENOENT");
        return realReaddir(p, opts);
      }) as unknown as typeof fsp.readdir,
    };
    const { manifest } = await captureManifest(root, { fs });
    expect(manifest.files.map((f) => f.path)).toEqual(["src/a.rs"]);
  });

  it("reports never-started when the tree races on both attempts", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n" });
    const fs = {
      ...fsp,
      lstat: (async (_p: string) => {
        throw raceErr("ENOENT");
      }) as typeof fsp.lstat,
    };
    await expect(captureManifest(root, { fs })).rejects.toMatchObject({ code: "SYNC_CONCURRENT_EDIT" });
  });
});

describe("captureManifest dir-symlink race", () => {
  it("retries a transient dir-to-symlink swap instead of capturing outside content", async () => {
    const root = makeTemp();
    const outside = makeTemp();
    writeTree(root, { "a/inner.txt": "inner\n" });
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const realReaddir = fsp.readdir;
    const rootAbs = path.resolve(root);
    const aAbs = path.join(root, "a");
    let rootReads = 0;
    const fs = {
      ...fsp,
      readdir: (async (p: string, opts: { withFileTypes: true }) => {
        if (p === rootAbs) {
          rootReads += 1;
          // Transient: restored before the retry lists the root again.
          if (rootReads === 2) {
            rmSync(aAbs);
            mkdirSync(aAbs, { recursive: true });
            writeFileSync(path.join(aAbs, "inner.txt"), "inner\n");
          }
        }
        const entries = await realReaddir(p, opts);
        if (p === rootAbs && rootReads === 1) {
          // Race: dir swapped for a link to outside between listing and descent.
          rmSync(aAbs, { recursive: true });
          symlinkSync(outside, aAbs);
        }
        return entries;
      }) as unknown as typeof fsp.readdir,
    };
    const { manifest } = await captureManifest(root, { fs });
    expect(manifest.files.map((f) => f.path)).toEqual(["a/inner.txt"]);
  });

  it("reports a persistent dir-to-symlink swap instead of following it outside", async () => {
    const root = makeTemp();
    const outside = makeTemp();
    writeTree(root, { "a/inner.txt": "inner\n" });
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const realReaddir = fsp.readdir;
    const rootAbs = path.resolve(root);
    const aAbs = path.join(root, "a");
    let swapped = false;
    const fs = {
      ...fsp,
      readdir: (async (p: string, opts: { withFileTypes: true }) => {
        const entries = await realReaddir(p, opts);
        if (p === rootAbs && !swapped) {
          // Race after the listing: the stacked dir is a link by descent time.
          swapped = true;
          rmSync(aAbs, { recursive: true });
          symlinkSync(outside, aAbs);
        }
        return entries;
      }) as unknown as typeof fsp.readdir,
    };
    // First attempt retries on the swapped dir; the retry sees a stable
    // escaping link and reports it precisely instead of following it.
    await expect(captureManifest(root, { fs })).rejects.toMatchObject({ code: "SYNC_ESCAPING_SYMLINK" });
  });
});

describe("captureManifest excluded symlinks", () => {
  it("skips an excluded dir name even when it is an escaping symlink", async () => {
    const root = makeTemp();
    const outside = makeTemp();
    writeTree(root, { "src/main.rs": "x\n" });
    symlinkSync(outside, path.join(root, "target"));
    const { manifest } = await captureManifest(root);
    expect(manifest.files.map((f) => f.path)).toEqual(["src/main.rs"]);
  });

  it("skips excluded secret files even when they are escaping symlinks", async () => {
    const root = makeTemp();
    writeTree(root, { "src/main.rs": "x\n" });
    symlinkSync("/etc/hostname", path.join(root, ".env"));
    const { manifest } = await captureManifest(root);
    expect(manifest.files.map((f) => f.path)).toEqual(["src/main.rs"]);
  });

  it("skips excluded dir names nested at any depth, in-root or escaping", async () => {
    const root = makeTemp();
    const outside = makeTemp();
    writeTree(root, { "src/main.rs": "x\n", "sub/keep.rs": "y\n" });
    symlinkSync(outside, path.join(root, "sub/target"));
    symlinkSync("src", path.join(root, "target"));
    const { manifest } = await captureManifest(root);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(["src/main.rs", "sub/keep.rs"]);
  });
});

describe("captureManifest open race", () => {
  it("retries when a file is swapped for a same-size link between lstat and open", async () => {
    const root = makeTemp();
    const original = "original-bytes-1";
    const tampered = "tampered-bytes-!";
    expect(tampered.length).toBe(original.length);
    writeTree(root, { "a.txt": original, "decoy.txt": tampered });
    const fixed = new Date(1_700_000_000_000);
    const aAbs = path.join(root, "a.txt");
    utimesSync(aAbs, fixed, fixed);
    utimesSync(path.join(root, "decoy.txt"), fixed, fixed);
    let swapped = false;
    const realOpen = fsp.open;
    const fs = {
      ...fsp,
      open: (async (p: string, flags: number) => {
        if (p === aAbs && !swapped) {
          swapped = true;
          // Transient file->link swap inside open: only O_NOFOLLOW (ELOOP)
          // distinguishes this from a clean read, because size and mtime match.
          rmSync(aAbs);
          symlinkSync("decoy.txt", aAbs);
          try {
            return await realOpen(p, flags);
          } finally {
            rmSync(aAbs);
            writeFileSync(aAbs, original);
            utimesSync(aAbs, fixed, fixed);
          }
        }
        return realOpen(p, flags);
      }) as typeof fsp.open,
    };
    const { manifest } = await captureManifest(root, { fs });
    expect(swapped).toBe(true);
    expect(manifest.files.find((f) => f.path === "a.txt")!.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  });
});

describe("captureSnapshot freeze races", () => {
  it("recaptures when a source file vanishes between hashing and copying", async () => {
    const root = makeTemp();
    const snapDir = makeTemp();
    writeTree(root, { "src/a.rs": "v1\n" });
    let copies = 0;
    const realCopyFile = fsp.copyFile;
    const fs = {
      ...fsp,
      copyFile: (async (src: string, dest: string) => {
        if (src === path.join(root, "src/a.rs") && copies === 0) {
          copies += 1;
          throw raceErr("ENOENT");
        }
        return realCopyFile(src, dest);
      }) as typeof fsp.copyFile,
    };
    const { manifest } = await captureSnapshot(root, snapDir, { fs });
    expect(manifest.files.map((f) => f.path)).toEqual(["src/a.rs"]);
    expect(readFileSync(path.join(snapDir, "src/a.rs"), "utf8")).toBe("v1\n");
  });
});

describe("captureSnapshot reuse", () => {
  it("recapturing into a reused dir replaces a stale link with the new file bytes", async () => {
    const root = makeTemp();
    const snap = makeTemp();
    writeTree(root, { "b.txt": "B1\n" });
    symlinkSync("b.txt", path.join(root, "a.txt"));
    await captureSnapshot(root, snap);
    expect(lstatSync(path.join(snap, "a.txt")).isSymbolicLink()).toBe(true);
    // The live link becomes a regular file; recapture into the same dir.
    rmSync(path.join(root, "a.txt"));
    writeFileSync(path.join(root, "a.txt"), "A2\n");
    const { manifest } = await captureSnapshot(root, snap);
    const snapA = path.join(snap, "a.txt");
    expect(lstatSync(snapA).isFile()).toBe(true);
    expect(readFileSync(snapA, "utf8")).toBe("A2\n");
    expect(manifest.files.find((f) => f.path === "a.txt")!.sha256).toBe(sha256File(snapA));
    // The link target was not clobbered through the stale link.
    expect(readFileSync(path.join(snap, "b.txt"), "utf8")).toBe("B1\n");
  });

  it("recapturing into a reused dir survives file-dir type changes in both directions", async () => {
    const root = makeTemp();
    const snap = makeTemp();
    writeTree(root, { "sub/inner.txt": "i\n", "flat.txt": "F1\n", "lnk/deep.txt": "d\n", "tgt.txt": "T\n" });
    await captureSnapshot(root, snap);
    // dir -> file, file -> dir, dir -> symlink.
    rmSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub"), "S2\n");
    rmSync(path.join(root, "flat.txt"));
    mkdirSync(path.join(root, "flat.txt"));
    writeFileSync(path.join(root, "flat.txt/k.txt"), "K\n");
    rmSync(path.join(root, "lnk"), { recursive: true });
    symlinkSync("tgt.txt", path.join(root, "lnk"));
    const { manifest } = await captureSnapshot(root, snap);
    expect(readFileSync(path.join(snap, "sub"), "utf8")).toBe("S2\n");
    expect(readFileSync(path.join(snap, "flat.txt/k.txt"), "utf8")).toBe("K\n");
    expect(lstatSync(path.join(snap, "lnk")).isSymbolicLink()).toBe(true);
    for (const f of manifest.files) {
      if (f.symlink === undefined) expect(sha256File(path.join(snap, f.path))).toBe(f.sha256);
    }
  });

  it("creates a missing snapshot dir, including nested parents", async () => {
    const root = makeTemp();
    writeTree(root, { "sub/a.txt": "A\n" });
    const snap = path.join(makeTemp(), "missing", "nested");
    const { manifest } = await captureSnapshot(root, snap);
    expect(readFileSync(path.join(snap, "sub/a.txt"), "utf8")).toBe("A\n");
    expect(manifest.files.map((f) => f.path)).toEqual(["sub/a.txt"]);
  });

  it("recapturing into a reused dir replaces a stale symlink parent with a real dir", async () => {
    const root = makeTemp();
    const snap = makeTemp();
    writeTree(root, { "tgt.txt": "T\n" });
    symlinkSync("tgt.txt", path.join(root, "lnk"));
    await captureSnapshot(root, snap);
    expect(lstatSync(path.join(snap, "lnk")).isSymbolicLink()).toBe(true);
    // symlink -> dir with content: the stale link parent must be replaced, not refused.
    rmSync(path.join(root, "lnk"));
    mkdirSync(path.join(root, "lnk"));
    writeFileSync(path.join(root, "lnk/deep.txt"), "D\n");
    const { manifest } = await captureSnapshot(root, snap);
    expect(lstatSync(path.join(snap, "lnk")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(snap, "lnk/deep.txt"), "utf8")).toBe("D\n");
    expect(manifest.files.find((f) => f.path === "lnk/deep.txt")!.sha256).toBe(sha256File(path.join(snap, "lnk/deep.txt")));
  });

  it("recapturing into a reused dir handles dot-dot-prefixed names as ordinary paths", async () => {
    const root = makeTemp();
    const snap = makeTemp();
    writeTree(root, { "..foo": "F1\n" });
    await captureSnapshot(root, snap);
    rmSync(path.join(root, "..foo"));
    mkdirSync(path.join(root, "..foo"));
    writeFileSync(path.join(root, "..foo/k.txt"), "K\n");
    const { manifest } = await captureSnapshot(root, snap);
    expect(readFileSync(path.join(snap, "..foo/k.txt"), "utf8")).toBe("K\n");
    expect(manifest.files.find((f) => f.path === "..foo/k.txt")!.sha256).toBe(sha256File(path.join(snap, "..foo/k.txt")));
  });
});

describe("planPush metadata changes", () => {
  it("sends a mode-only change so a chmod +x build script does not stay stale", async () => {
    const root = makeTemp();
    writeTree(root, { "scripts/build.sh": "echo hi\n" });
    const abs = path.join(root, "scripts/build.sh");
    chmodSync(abs, 0o644);
    const before = (await captureManifest(root)).manifest;
    chmodSync(abs, 0o755);
    const after = (await captureManifest(root)).manifest;
    expect(planPush(before, after).toSend.map((f) => f.path)).toEqual(["scripts/build.sh"]);
  });

  it("sends an mtime-only change so touched files keep cargo fingerprints honest", async () => {
    const root = makeTemp();
    writeTree(root, { "src/a.rs": "a\n" });
    const before = (await captureManifest(root)).manifest;
    const abs = path.join(root, "src/a.rs");
    const later = new Date(Date.now() + 5000);
    utimesSync(abs, later, later);
    const after = (await captureManifest(root)).manifest;
    expect(planPush(before, after).toSend.map((f) => f.path)).toEqual(["src/a.rs"]);
  });
});

describe("LocalGuestStore.push metadata-only sync", () => {
  it("applies a mode change without rewriting bytes", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "scripts/build.sh": "echo hi\n" });
    chmodSync(path.join(live, "scripts/build.sh"), 0o644);
    const store = new LocalGuestStore();
    const first = await captureSnapshot(live, snapDir);
    await store.push(snapDir, planPush(null, first.manifest).toSend, guest);
    chmodSync(path.join(live, "scripts/build.sh"), 0o755);
    const second = await captureSnapshot(live, snapDir);
    const plan = planPush(first.manifest, second.manifest);
    expect(plan.toSend.map((f) => f.path)).toEqual(["scripts/build.sh"]);
    const result = await store.push(snapDir, plan.toSend, guest);
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(0);
    expect(lstatSync(path.join(guest, "scripts/build.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(guest, "scripts/build.sh"), "utf8")).toBe("echo hi\n");
  });

  it("applies an mtime-only change in place", async () => {
    const live = makeTemp();
    const snapDir = makeTemp();
    const guest = makeTemp();
    writeTree(live, { "src/a.rs": "a\n" });
    const store = new LocalGuestStore();
    const first = await captureSnapshot(live, snapDir);
    await store.push(snapDir, planPush(null, first.manifest).toSend, guest);
    const liveAbs = path.join(live, "src/a.rs");
    const later = new Date(Date.now() + 5000);
    utimesSync(liveAbs, later, later);
    const second = await captureSnapshot(live, snapDir);
    const plan = planPush(first.manifest, second.manifest);
    expect(plan.toSend.map((f) => f.path)).toEqual(["src/a.rs"]);
    const result = await store.push(snapDir, plan.toSend, guest);
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(0);
    expect(Math.floor(lstatSync(path.join(guest, "src/a.rs")).mtimeMs)).toBe(Math.floor(later.getTime()));
  });
});

describe("LocalGuestStore.readBounded", () => {
  /** Test double: an open hook whose handle stats `size` but streams `chunks`. */
  function fakeOpen({ size, chunks }: { size: number; chunks: Buffer[] }): typeof fsp.open {
    const handle = {
      stat: async () => ({ isFile: () => true, size }),
      createReadStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
        destroy() {},
      }),
      close: async () => {},
    };
    return (async () => handle) as unknown as typeof fsp.open;
  }

  it("returns bytes within the cap, null past it, and never follows links", async () => {
    const guest = makeTemp();
    writeTree(guest, { "small.snap": "s\n", "big.snap": `${"x".repeat(100)}\n` });
    symlinkSync("small.snap", path.join(guest, "link.snap"));
    const store = new LocalGuestStore();
    expect((await store.readBounded(guest, "small.snap", 1024))?.toString()).toBe("s\n");
    expect(await store.readBounded(guest, "big.snap", 8)).toBeNull();
    expect(await store.readBounded(guest, "link.snap", 1024)).toBeNull();
    expect(await store.readBounded(guest, "missing.snap", 1024)).toBeNull();
  });

  it("refuses reads through a symlinked parent", async () => {
    const guest = makeTemp();
    const outside = makeTemp();
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, path.join(guest, "sub"));
    const store = new LocalGuestStore();
    await expect(store.readBounded(guest, "sub/secret.txt", 1024)).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
  });

  it("returns null when the stream outgrows the cap even though stat passed", async () => {
    const guest = makeTemp();
    writeTree(guest, { "small.snap": "s\n" });
    // Stats 2 bytes (passes both pre-checks) but streams 24: a guest file that
    // grew between stat and read, or a size-zero reporter like /proc/version.
    const chunks = [Buffer.alloc(8, 1), Buffer.alloc(8, 2), Buffer.alloc(8, 3)];
    const store = new LocalGuestStore({ open: fakeOpen({ size: 2, chunks }) });
    await expect(store.readBounded(guest, "small.snap", 16)).resolves.toBeNull();
  });

  it("returns bytes when the hooked stream stays within the cap", async () => {
    const guest = makeTemp();
    writeTree(guest, { "small.snap": "s\n" });
    const store = new LocalGuestStore({ open: fakeOpen({ size: 2, chunks: [Buffer.from("abc")] }) });
    expect((await store.readBounded(guest, "small.snap", 16))?.toString()).toBe("abc");
  });
});

describe("collectAndStage bounded staging", () => {
  it("skips the read entirely when the scanned size already exceeds the remaining budget", async () => {
    const live = makeTemp();
    const guestDir = makeTemp();
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guestDir, { "Cargo.lock": `v1\n${"y".repeat(100)}\n` });
    const uploaded = (await captureManifest(live)).manifest;
    const inner = new LocalGuestStore();
    let reads = 0;
    const counting = Object.create(inner);
    counting.readBounded = async (...args: [string, string, number]) => {
      reads += 1;
      return inner.readBounded(...args);
    };
    counting.read = async (...args: [string, string]) => {
      reads += 1;
      // Legacy entry point, kept in the spy so the pre-check test also fails
      // against an implementation that still reads instead of bounding.
      return (inner as unknown as { read: (...a: [string, string]) => Promise<Buffer> }).read(...args);
    };
    const result = await collectAndStage({
      liveRoot: live, uploaded, guest: counting, guestDir, stagingDir: path.join(makeTemp(), "cmd-cap"), maxStagedBytes: 8,
    });
    expect(result.truncated).toBe(true);
    expect(reads).toBe(0);
    expect(result.changes.find((c) => c.path === "Cargo.lock")!.stagedRelPath).toBeNull();
  });

  it("marks truncated when a guest file outgrows the budget mid-read, keeping metadata", async () => {
    const live = makeTemp();
    const guestDir = makeTemp();
    writeTree(live, { "Cargo.lock": "v1\n" });
    writeTree(guestDir, { "Cargo.lock": "v1\n# g\n" });
    const uploaded = (await captureManifest(live)).manifest;
    const inner = new LocalGuestStore();
    // Small on scan (passes the pre-check) but unreadable past the budget at read time.
    const growing = Object.create(inner);
    growing.readBounded = async () => null;
    const staging = path.join(makeTemp(), "cmd-grow");
    const result = await collectAndStage({ liveRoot: live, uploaded, guest: growing, guestDir, stagingDir: staging });
    expect(result.truncated).toBe(true);
    expect(result.state).toBe("staged");
    const change = result.changes.find((c) => c.path === "Cargo.lock")!;
    expect(change.stagedRelPath).toBeNull();
    expect(change.returnedSha256).not.toBeNull();
    expect(JSON.parse(readFileSync(path.join(staging, "manifest.json"), "utf8")).truncated).toBe(true);
  });
});

describe("collectStreamCapped", () => {
  it("buffers a stream that stays within the cap", async () => {
    async function* chunks() {
      yield Buffer.from("ab");
      yield Buffer.from("c");
    }
    expect((await collectStreamCapped(chunks(), 8))?.toString()).toBe("abc");
  });

  it("returns null when the stream grows past the cap mid-read", async () => {
    async function* growing() {
      yield Buffer.alloc(8, 1);
      yield Buffer.alloc(8, 2);
      yield Buffer.alloc(8, 3);
    }
    await expect(collectStreamCapped(growing(), 16)).resolves.toBeNull();
  });
});

describe("resolveContained", () => {
  it("resolves in-mirror paths and rejects lexical traversal", async () => {
    const root = makeTemp();
    expect(await resolveContained(root, "a/b.txt")).toBe(path.resolve(root, "a/b.txt"));
    await expect(resolveContained(root, "../x")).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
  });

  it("rejects paths under a symlinked parent", async () => {
    const root = makeTemp();
    const outside = makeTemp();
    symlinkSync(outside, path.join(root, "sub"));
    await expect(resolveContained(root, "sub/file.txt")).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
  });
});

describe("mirror parent-symlink containment", () => {
  it("refuses pushes through a symlinked mirror parent", async () => {
    const snapDir = makeTemp();
    const guest = makeTemp();
    const outside = makeTemp();
    writeTree(snapDir, { "sub/file.txt": "x\n" });
    symlinkSync(outside, path.join(guest, "sub"));
    const store = new LocalGuestStore();
    await expect(
      store.push(snapDir, [{ path: "sub/file.txt", size: 2, mtimeMs: 1, mode: 0o644, sha256: "x" }], guest),
    ).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
    expect(existsSync(path.join(outside, "file.txt"))).toBe(false);
  });

  it("refuses prune deletes through a symlinked mirror parent", async () => {
    const guest = makeTemp();
    const outside = makeTemp();
    writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    symlinkSync(outside, path.join(guest, "sub"));
    const store = new LocalGuestStore();
    await expect(store.pruneMirror(guest, ["sub/keep.txt"])).rejects.toMatchObject({ code: "SYNC_TRAVERSAL" });
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
