import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FILE_SYNC_SCRIPT } from "./file-sync-script.js";
import { gnuExtensionHeader } from "./test-support/native-sync-review-fixtures.js";

for (const type of ["L", "K"] as const) {
  it(`${type}: rejects declared 262145-byte metadata before requesting its complete body`, async () => {
    // Guard-disabled mutant must block waiting for the missing extension body,
    // not fail at NAME_MAX, EOF, or a later tar-member validation.
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "metadata-bound-"));
    const target = path.join(root, "target");
    const child = spawn("python3", ["-c", FILE_SYNC_SCRIPT, "receive", JSON.stringify({
      sourcePath: path.join(root, "source"), targetPath: target, kind: "directory",
    })], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (bytes) => { stderr += String(bytes); });
    child.stdin.on("error", () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1800);
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      // tarfile's initial 10-KiB read-ahead is satisfied. Stdin deliberately
      // stays OPEN, with most of the declared body withheld forever.
      child.stdin.write(Buffer.concat([gnuExtensionHeader(type, 262145), Buffer.alloc(10240 - 512)]));
      const code = await closed;
      expect(timedOut, "metadata guard must reject before buffering the withheld body").toBe(false);
      expect(code).not.toBe(0);
      expect(stderr).toContain("tar extension exceeds metadata limit");
      expect(stderr).not.toContain("File name too long");
      expect(existsSync(path.join(target, "short"))).toBe(false);
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
