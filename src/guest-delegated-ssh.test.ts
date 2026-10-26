import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/guest/paperclip-delegated-ssh is the sshd ForceCommand of the
// delegated offload template. Without a user bus it must behave exactly like
// plain sshd: same exit status, same stdin/stdout.
const script = path.resolve(__dirname, "../scripts/guest/paperclip-delegated-ssh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(command: string, input = "") {
  const runtime = mkdtempSync(path.join(tmpdir(), "no-user-bus-"));
  dirs.push(runtime);
  return spawnSync("/bin/sh", [script], {
    input, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: runtime, SHELL: "/bin/sh", XDG_RUNTIME_DIR: runtime, SSH_ORIGINAL_COMMAND: command },
  });
}

describe("paperclip-delegated-ssh without a user bus", () => {
  it.skipIf(process.platform === "win32")("passes the command exit status through", () => {
    expect(run("exit 7").status).toBe(7);
  });
  it.skipIf(process.platform === "win32")("passes stdin and stdout through", () => {
    expect(run("cat", "hello\n").stdout).toBe("hello\n");
  });
});
