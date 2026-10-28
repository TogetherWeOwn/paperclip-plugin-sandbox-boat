import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/guest/paperclip-delegated-ssh is the sshd ForceCommand of the
// delegated offload template. Without a user bus it must behave exactly like
// plain sshd: same exit status, same stdin/stdout.
const script = path.resolve(__dirname, "../scripts/guest/paperclip-delegated-ssh");
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

describe("paperclip-delegated-ssh with a user bus", () => {
  // A stand-in systemd-run records its argv and then runs the command after
  // "--", as a real scope does in place.
  async function delegated(command: string, input = "") {
    const runtime = mkdtempSync(path.join(tmpdir(), "user-bus-"));
    dirs.push(runtime);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path.join(runtime, "bus"), resolve));
    const bin = path.join(runtime, "bin");
    const log = path.join(runtime, "argv.log");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
    chmodSync(path.join(bin, "systemd-run"), 0o755);
    const result = spawnSync("/bin/sh", [script], {
      input, encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: runtime, SHELL: "/bin/sh", XDG_RUNTIME_DIR: runtime, SSH_ORIGINAL_COMMAND: command },
    });
    return { result, argv: readFileSync(log, "utf8").trim().split("\n") as string[] };
  }

  it.skipIf(process.platform === "win32")("runs the command in a delegated user scope", async () => {
    const { result, argv } = await delegated("exit 7");
    expect(argv.slice(0, argv.indexOf("--"))).toEqual(["--user", "--scope", "--quiet", "--collect", "-p", "Delegate=yes"]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", "exit 7"]);
    expect(result.status).toBe(7);
  });
  it.skipIf(process.platform === "win32")("keeps stdin and stdout through the scope", async () => {
    expect((await delegated("cat", "hello\n")).result.stdout).toBe("hello\n");
  });
});
