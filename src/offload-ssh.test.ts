import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { SshOffloadGuest } from "./offload-ssh.js";
import { OffloadLifecycle } from "./offload-lifecycle.js";
import { commandDigest } from "./offload-journal.js";
import type { OffloadCommand } from "./offload.js";

let ssh: LoopbackSsh;
let guest: SshOffloadGuest;
let parent: string;
const cmd = (timeoutMs = 10_000): OffloadCommand => ({ commandId: randomUUID(), companyId: "company", runId: "run",
  cardId: "card", repoId: "public-repo", profileId: "test", argv: ["test"], timeoutMs });
async function delegatedParent(): Promise<string> {
  const current = (await readFile("/proc/self/cgroup", "utf8")).trim().split("::")[1];
  for (const candidate of [process.env.PAPERCLIP_TEST_CGROUP_PARENT, `/sys/fs/cgroup${current}`,
    `/sys/fs/cgroup/user.slice/user-${userInfo().uid}.slice/user@${userInfo().uid}.service`]) {
    if (!candidate) continue;
    try { await access(candidate, constants.W_OK); return candidate; } catch { /* Try another delegated root. */ }
  }
  return "/sys/fs/cgroup/boat-no-delegation";
}
beforeEach(async () => {
  ssh = new LoopbackSsh();
  await ssh.start();
  parent = path.join(await delegatedParent(), `boat-ssh-test-${randomUUID()}`);
  await mkdir(parent).catch(() => undefined);
  guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
    stateRoot: ssh.root, workspace: async () => ssh.root, executable: "/bin/sh",
    args: () => ["-c", "printf 'hello'; printf 'error' >&2; exit 7"] });
  if (process.env.PAPERCLIP_TEST_CGROUP_REQUIRED === "1") {
    expect((await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated).toBe(true);
  }
}, 15_000);
afterEach(async () => {
  await guest?.shutdown();
  await ssh?.cleanup();
  if (parent) await rmdir(parent).catch(() => undefined);
}, 15_000);
async function identity(command: OffloadCommand) {
  const boot = await guest.bootId(ssh.session.sandboxId);
  const lifecycle = new OffloadLifecycle(guest, Date.now, { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) });
  const full = await lifecycle.prepare(ssh.session.sandboxId, command, { companyId: command.companyId,
    runId: command.runId, commandId: command.commandId, digest: commandDigest(command),
    sandboxId: ssh.session.sandboxId, guestBootId: boot, journalGeneration: 1 });
  return { lifecycle, full };
}

describe("concrete guest lifecycle over real multiplexed SSH", () => {
  it("refuses without real cgroup delegation instead of claiming a process-group fallback", async () => {
    const unavailable = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session,
      cgroupParent: path.join(ssh.root, "not-a-cgroup"), stateRoot: ssh.root, workspace: async () => ssh.root });
    expect(await unavailable.preflight(ssh.session.sandboxId, cmd())).toEqual({ cgroupV2Delegated: false, outsideWatchdogVerified: false });
    await unavailable.shutdown();
  });

  it("prepares, arms, streams both channels and verifies an empty real subtree", async () => {
    const command = cmd();
    const capabilities = await guest.preflight(ssh.session.sandboxId, command);
    if (!capabilities.cgroupV2Delegated) {
      // CI without delegated cgroups still exercises the real SSH refusal path.
      await expect(identity(command)).rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE" });
      return;
    }
    const { lifecycle, full } = await identity(command);
    const output = { stdout: "", stderr: "" };
    const result = await lifecycle.run(full, command, (vm, c, context) => guest.runCommand(vm, c, context),
      async (stream, bytes) => { output[stream] += Buffer.from(bytes).toString(); });
    expect(result.exitCode).toBe(7);
    expect(output).toEqual({ stdout: "hello", stderr: "error" });
    expect(await guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    expect(await guest.receipt(full)).toMatchObject({ kind: "result", identity: full, result: { exitCode: 7 } });
    // Re-sending a delivered start cannot execute it again.
    await expect(guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} }))
      .rejects.toThrow();
  }, 20_000);

  it("renews guest interest with a bounded deadline and rejects arbitrary extensions", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    const { full } = await identity(cmd());
    const renewed = { ...full, heartbeatDeadline: Date.now() + 30_000 };
    await guest.heartbeat(ssh.session.sandboxId, renewed);
    expect((await guest.inspect(ssh.session.sandboxId, renewed)).identity.heartbeatDeadline).toBe(renewed.heartbeatDeadline);
    await expect(guest.heartbeat(ssh.session.sandboxId, { ...renewed, heartbeatDeadline: Date.now() + 60_000 })).rejects.toThrow();
  }, 15_000);

  it("rejects stale boot/group identities before signalling any process", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    const { full } = await identity(cmd());
    await expect(guest.kill(ssh.session.sandboxId, { ...full, guestBootId: "rebooted" })).rejects.toThrow();
    await expect(guest.term(ssh.session.sandboxId, { ...full, processGroupId: full.processGroupId + 1 })).rejects.toThrow();
    await guest.kill(ssh.session.sandboxId, full);
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
  }, 15_000);

  it("cancels a TERM-resistant subtree without touching the shared SSH master", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    const marker = path.join(ssh.root, "ignoring-term");
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3", path: "/usr/bin:/bin",
      args: () => ["-c", `import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open(${JSON.stringify(marker)},'w').close(); time.sleep(60)`] });
    const command = cmd(15_000);
    const { lifecycle, full } = await identity(command);
    const pending = lifecycle.run(full, command, (vm, c, context) => guest.runCommand(vm, c, context), async () => {});
    await expect.poll(() => readFile(marker, "utf8").catch(() => null)).toBe("");
    await lifecycle.cancel(full, "client_cancel");
    expect(await pending).toMatchObject({ exitCode: 130, cancelled: true });
    expect(await guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    expect(ssh.session.master?.exitCode).toBe(null);
  }, 20_000);

  it("holds uncertainty rather than polling forever after a lost guest supervisor", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    const command = cmd();
    const { full } = await identity(command);
    await guest.armDeadline(ssh.session.sandboxId, full);
    const state = JSON.parse(await readFile(path.join(ssh.root, path.basename(full.cgroupPath), "state"), "utf8"));
    // This PID came from this test's freshly prepared private state directory.
    process.kill(state.supervisorPid, "SIGKILL");
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    await expect(guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} }))
      .rejects.toThrow();
  }, 15_000);

  it("fails closed on output overflow rather than publishing a truncated success receipt", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3", path: "/usr/bin:/bin",
      args: () => ["-c", "import sys; sys.stdout.buffer.write(b'x' * 1100000)"] });
    const command = cmd();
    const { lifecycle, full } = await identity(command);
    await expect(lifecycle.run(full, command, (vm, c, context) => guest.runCommand(vm, c, context), async () => {}))
      .rejects.toMatchObject({ code: "OFFLOAD_OUTPUT_LIMIT" });
    expect(await guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    expect(await guest.receipt(full)).toBe(null);
  }, 15_000);

  it("guest watchdog kills detached descendants without a host cancellation timer", async () => {
    if (!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated) return;
    const marker = path.join(ssh.root, "payload-started");
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3", args: () => ["-c",
        `import os,time; open(${JSON.stringify(marker)},'w').close(); p=os.fork(); os.setsid() if p == 0 else None; time.sleep(60)`] });
    const command = cmd(1_500);
    const { full } = await identity(command);
    expect(await guest.armDeadline(ssh.session.sandboxId, full)).toEqual({ verified: true, outsideCommandCgroup: true });
    const pending = guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} });
    await expect.poll(() => readFile(marker, "utf8").catch(() => null)).toBe("");
    expect(await pending).toMatchObject({ exitCode: 124 });
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full), { timeout: 5_000 }).toBe(true);
  }, 15_000);
});
