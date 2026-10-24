// Real OpenSSH only. A missing executable is an explicit prerequisite FAILURE,
// never a skip or a substitution with the signal-forwarding Python relay.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FILE_SYNC_SCRIPT } from "./file-sync-script.js";
import { shellQuote } from "./shell.js";
import { hostileTar, put, waitFor } from "./test-support/local-sync-ssh.js";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";

let fixture: LoopbackSsh;
beforeEach(async () => { fixture = new LoopbackSsh(); await fixture.start(); });
afterEach(async () => { await fixture?.cleanup(); });

async function alive(pidFile: string) {
  const pid = Number(await readFile(pidFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid test-only remote PID");
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

for (const descendant of [false, true]) {
  it(`500-ms deadline terminates ${descendant ? "descendant process group" : "remote shell"} before returning, without killing master`, async () => {
    const { manager, session, root } = fixture;
    const marker = path.join(root, "late");
    const pid = path.join(root, "pid");
    const childPid = path.join(root, "child-pid");
    const timed = `sleep 2; printf late > ${shellQuote(marker)}`;
    const command = `printf '%s' $$ > ${shellQuote(pid)}; ` + (descendant
      ? `sh -c ${shellQuote(`printf '%s' $$ > ${shellQuote(childPid)}; ${timed}`)} & wait`
      : timed);
    const masterPid = session.master!.pid;
    const started = Date.now();
    const pending = manager.runStream(session, command, { timeoutMs: 500 });
    await waitFor(() => existsSync(descendant ? childPid : pid), "remote timed command never started");
    const result = await pending;
    expect.soft(result.timedOut).toBe(true);
    expect.soft(Date.now() - started).toBeLessThan(1800);
    expect.soft(await alive(pid), "remote shell must be dead when runStream returns").toBe(false);
    if (descendant) expect.soft(await alive(childPid), "remote descendant must be dead before return").toBe(false);
    expect.soft(manager.masterAlive(session)).toBe(true);
    expect.soft(session.master!.pid).toBe(masterPid);
    expect.soft(await manager.runStream(session, "printf subsequent", { timeoutMs: 1500 })).toMatchObject({
      exitCode: 0, timedOut: false, stdout: "subsequent",
    });
    // Wait past the actual scheduled write, rather than asserting absence at
    // 500 ms when even the broken implementation has not written anything yet.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 2400 - Date.now())));
    expect.soft(existsSync(marker), "timed-out remote command must never perform its delayed write").toBe(false);
    expect.soft(await alive(pid)).toBe(false);
    if (descendant) expect.soft(await alive(childPid)).toBe(false);
  }, 15000);
}

it("multiplexed binary receiver timeout cleans partial scratch before returning and preserves old target", async () => {
  const { manager, session, root } = fixture;
  const target = path.join(root, "destination", "file");
  await put(target, "old complete contents", 0o600);
  const source = new PassThrough();
  const mapping = JSON.stringify({ sourcePath: path.join(root, "unused"), targetPath: target, kind: "file" });
  const pending = manager.runStream(session, `exec python3 -c ${shellQuote(FILE_SYNC_SCRIPT)} receive ${shellQuote(mapping)}`, {
    stdin: source, timeoutMs: 700,
  });
  // Real tar header declares a much larger body; hold at real payload bytes.
  const archive = hostileTar([{ name: "payload", body: "x".repeat(2 * 1024 * 1024) }]);
  source.write(archive.subarray(0, 128 * 1024));
  await waitFor(async () => (await readdir(path.dirname(target))).some((name) => name.startsWith(".paperclip-upload.")),
    "real receiver never populated staging scratch");
  const result = await pending;
  expect.soft(result.timedOut).toBe(true);
  expect.soft(await readFile(target, "utf8")).toBe("old complete contents");
  expect.soft(await readdir(path.dirname(target)), "receiver must clean scratch before timeout completion").toEqual(["file"]);
  expect.soft(manager.masterAlive(session)).toBe(true);
  expect.soft(await manager.runStream(session, "printf reusable", { timeoutMs: 1500 })).toMatchObject({
    exitCode: 0, timedOut: false, stdout: "reusable",
  });
  source.destroy();
}, 15000);
