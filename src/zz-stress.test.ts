import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { SshOffloadGuest } from "./offload-ssh.js";
import { OffloadLifecycle } from "./offload-lifecycle.js";
import { commandDigest } from "./offload-journal.js";
let ssh: LoopbackSsh; let guest: SshOffloadGuest; let parent: string;
beforeEach(async () => {
  ssh = new LoopbackSsh(); await ssh.start();
  const current = (await readFile("/proc/self/cgroup", "utf8")).trim().split("::")[1];
  parent = path.join(`/sys/fs/cgroup${current}`, `boat-ssh-stress-${randomUUID()}`); await mkdir(parent);
  guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
    stateRoot: ssh.root, workspace: async () => ssh.root, executable: "/bin/sh", args: () => ["-c", "exit 0"] });
}, 15_000);
afterEach(async () => { await guest.shutdown(); await ssh.cleanup(); await rmdir(parent).catch(() => undefined); }, 60_000);
it("prepare stress", async () => {
  const N = Number(process.env.N ?? 100); let fails = 0;
  for (let i = 0; i < N; i++) {
    const command = { commandId: randomUUID(), companyId: "c", runId: "r", cardId: "k", repoId: "p", profileId: "t", argv: ["t"], timeoutMs: 10_000 };
    const boot = await guest.bootId(ssh.session.sandboxId);
    const lc = new OffloadLifecycle(guest, Date.now, { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) });
    try {
      const full = await lc.prepare(ssh.session.sandboxId, command as never, { companyId: "c", runId: "r", commandId: command.commandId,
        digest: commandDigest(command as never), sandboxId: ssh.session.sandboxId, guestBootId: boot, journalGeneration: 1 });
      await guest.kill(ssh.session.sandboxId, full);
    } catch { fails++; }
  }
  console.log(`STRESS prepares=${N} failed=${fails}`);
  expect(fails).toBe(0);
}, 600_000);
