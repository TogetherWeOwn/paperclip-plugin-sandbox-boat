import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_GUEST_SCAN_ENTRIES, SshGuestStore } from "./offload-ssh-guest-store.js";
import { liveHash, SyncError } from "./offload-sync.js";

const SHA = "a".repeat(64);

/** A guest whose scan script prints exactly `output`. */
function guestPrinting(output: unknown): SshGuestStore {
  const stdout = typeof output === "string" ? output : JSON.stringify(output);
  const ssh = {
    runStream: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" }),
    ensureKey: async () => ({ privateKeyPath: "/test/id_ed25519", publicKey: "test" }),
  };
  return new SshGuestStore({ ssh: ssh as never, session: {} as never });
}

async function scanError(output: unknown): Promise<SyncError> {
  const error = await guestPrinting(output).scan("/guest/mirror").then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SyncError);
  return error as SyncError;
}

describe("SshGuestStore.scan validates guest output on the host", () => {
  it("accepts well-formed file, link and escaping entries", async () => {
    const scanned = await guestPrinting({
      "src/a.rs": { size: 3, mtimeMs: 1.5, sha256: SHA },
      "link": { size: 4, mtimeMs: 2, sha256: SHA, symlink: "src/a.rs" },
      "out": { size: 0, mtimeMs: 3, sha256: "", escaping: true },
    }).scan("/guest/mirror");
    expect([...scanned.keys()].sort()).toEqual(["link", "out", "src/a.rs"]);
    expect(scanned.get("out")).toEqual({ size: 0, mtimeMs: 3, sha256: "", escaping: true });
  });

  for (const rel of ["../escape", "/etc/passwd", "a/../../b", "a//b", "./a", "a/.", "", "a\0b"]) {
    it(`rejects scan key ${JSON.stringify(rel)}`, async () => {
      expect((await scanError({ [rel]: { size: 1, mtimeMs: 1, sha256: SHA } })).code).toBe("SYNC_TRAVERSAL");
    });
  }

  it("drops default-excluded runtime state and secrets", async () => {
    const scanned = await guestPrinting({
      "keep.txt": { size: 1, mtimeMs: 1, sha256: SHA },
      ".paperclip-runtime/state": { size: 1, mtimeMs: 1, sha256: SHA },
      "nested/.git/config": { size: 1, mtimeMs: 1, sha256: SHA },
      ".boat-offload/mirror.json": { size: 1, mtimeMs: 1, sha256: SHA },
      ".env": { size: 1, mtimeMs: 1, sha256: SHA },
      "pkg/.npmrc": { size: 1, mtimeMs: 1, sha256: SHA },
    }).scan("/guest/mirror");
    expect([...scanned.keys()]).toEqual(["keep.txt"]);
  });

  const malformed: Array<[string, unknown]> = [
    ["array result", []],
    ["null result", null],
    ["string entry", { a: "x" }],
    ["negative size", { a: { size: -1, mtimeMs: 1, sha256: SHA } }],
    ["fractional size", { a: { size: 1.5, mtimeMs: 1, sha256: SHA } }],
    ["string size", { a: { size: "1", mtimeMs: 1, sha256: SHA } }],
    ["missing mtime", { a: { size: 1, sha256: SHA } }],
    ["short hash", { a: { size: 1, mtimeMs: 1, sha256: "abc" } }],
    ["empty hash without escaping", { a: { size: 1, mtimeMs: 1, sha256: "" } }],
    ["non-boolean escaping", { a: { size: 0, mtimeMs: 1, sha256: "", escaping: "yes" } }],
    ["escaping with a link target", { a: { size: 0, mtimeMs: 1, sha256: "", escaping: true, symlink: "/etc" } }],
    ["non-string link", { a: { size: 1, mtimeMs: 1, sha256: SHA, symlink: 7 } }],
  ];
  for (const [label, output] of malformed) {
    it(`rejects ${label}`, async () => {
      expect((await scanError(output)).code).toBe("SYNC_GUEST_READ");
    });
  }

  it("rejects a scan over the entry limit", async () => {
    const entries: string[] = [];
    for (let i = 0; i <= MAX_GUEST_SCAN_ENTRIES; i += 1) entries.push(`"f${i}":{"size":0,"mtimeMs":0,"sha256":"${SHA}"}`);
    expect((await scanError(`{${entries.join(",")}}`)).code).toBe("SYNC_GUEST_READ");
  });
});

describe("liveHash", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function temp(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "boat-live-hash-"));
    dirs.push(dir);
    return dir;
  }

  it("stream-hashes a regular file", async () => {
    const live = temp();
    writeFileSync(path.join(live, "a"), "bytes");
    expect(await liveHash(live, "a")).toBe(createHash("sha256").update("bytes").digest("hex"));
  });

  it("reports a file over the byte cap without hashing it", async () => {
    const live = temp();
    writeFileSync(path.join(live, "big"), Buffer.alloc(2048));
    expect(await liveHash(live, "big", 1024)).toBe("oversized");
    expect(await liveHash(live, "big", 2048)).toBe(createHash("sha256").update(Buffer.alloc(2048)).digest("hex"));
  });

  it("never reads through a symlinked live parent", async () => {
    const live = temp();
    const outside = temp();
    writeFileSync(path.join(outside, "secret"), "outside bytes");
    symlinkSync(outside, path.join(live, "pivot"));
    expect(await liveHash(live, "pivot/secret")).toBe("non-regular");
  });

  it("hashes a leaf link by its target rather than following it", async () => {
    const live = temp();
    mkdirSync(path.join(live, "d"));
    symlinkSync("/etc/hostname", path.join(live, "d", "leaf"));
    expect(await liveHash(live, "d/leaf")).toBe(createHash("sha256").update("offload-symlink\0/etc/hostname").digest("hex"));
  });
});
