import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { access, mkdir, readdir, readFile, readlink, rmdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { CGROUP_GATED, CGROUP_SKIP_NOTE, markCgroupGated } from "./test-support/cgroup-gate.js";
import { SshOffloadGuest } from "./offload-ssh.js";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";
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
// Without delegated cgroup v2 these tests report as skipped, not passed. The
// gate tag lets the cgroup gate reporter list what ran and what did not.
async function requireDelegation(ctx: TestContext): Promise<void> {
  markCgroupGated(ctx);
  ctx.skip(!(await guest.preflight(ssh.session.sandboxId, cmd())).cgroupV2Delegated, CGROUP_SKIP_NOTE);
}
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
    expect(await unavailable.preflight(ssh.session.sandboxId, cmd())).toEqual({ cgroupV2Delegated: false,
      outsideWatchdogVerified: false, ineligibleReason: "parent_not_delegated" });
    await unavailable.shutdown();
  });

  it("preflight names each ineligible sub-cause without reflecting guest bytes", async () => {
    const withScript = (script: string, cgroupParent = parent) => new SshOffloadGuest({ ssh: ssh.manager,
      session: async () => ssh.session, cgroupParent, stateRoot: ssh.root, workspace: async () => ssh.root, script });
    const cases: Array<[string, string, string]> = [
      // A guest-reported probe refusal carries its allowlisted step token.
      ["probe token", `import json; print(json.dumps("probe_mkdir_failed:EACCES"))`, "probe_mkdir_failed:EACCES"],
      ["probe token without errno", `import json; print(json.dumps("probe_kill_failed"))`, "probe_kill_failed"],
      // A legacy guest's bare false and any unrecognized guest string both
      // collapse to the generic token; guest bytes are never echoed.
      ["legacy false", `import json; print(json.dumps(False))`, "guest_reported_ineligible"],
      ["guest garbage", `import json; print(json.dumps("evil /home/agent/.ssh/id_ed25519 EACCES"))`, "guest_reported_ineligible"],
      ["guest object", `import json; print(json.dumps({"eligible": False, "why": "secret"}))`, "guest_reported_ineligible"],
      // A guest process that dies mid-RPC is a transport failure, distinct
      // from any guest-reported verdict.
      ["rpc exit", `import sys; sys.exit(3)`, "preflight_rpc_failed:OFFLOAD_GUEST_TRANSPORT_UNKNOWN"],
      ["rpc bad json", `print("not json")`, "preflight_rpc_failed:OFFLOAD_GUEST_TRANSPORT_UNKNOWN"],
    ];
    for (const [name, script, ineligibleReason] of cases) {
      const candidate = withScript(script);
      try {
        const capabilities = await candidate.preflight(ssh.session.sandboxId, cmd());
        expect(capabilities, name).toEqual({ cgroupV2Delegated: false, outsideWatchdogVerified: false, ineligibleReason });
        expect(JSON.stringify(capabilities), name).not.toContain("secret");
        expect(JSON.stringify(capabilities), name).not.toContain("/home/agent");
      } finally {
        await candidate.shutdown();
      }
    }
    // The real probe on a symlinked configured parent: canonical() refuses
    // before any cgroup access, and the token says so instead of reading as
    // a transport failure.
    const { symlink } = await import("node:fs/promises");
    const link = path.join(ssh.root, "parent-link");
    await symlink("/sys/fs/cgroup", link);
    const symlinked = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session,
      cgroupParent: link, stateRoot: ssh.root, workspace: async () => ssh.root });
    try {
      expect(await symlinked.preflight(ssh.session.sandboxId, cmd())).toEqual({ cgroupV2Delegated: false,
        outsideWatchdogVerified: false, ineligibleReason: "parent_invalid" });
    } finally {
      await symlinked.shutdown();
    }
  });

  it("host env gate refuses prepare with its own detail, distinct from guest sub-causes", async () => {
    const command = cmd();
    command.env = { CARGO_TERM_COLOR: "always", SOME_SECRET: "nope" };
    await expect(guest.prepare(ssh.session.sandboxId, command))
      .rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE", detail: "host_env_gate" });
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
    const receipt = await guest.receipt(full) as { kind: string; identity: Record<string, unknown>; result: unknown };
    expect(receipt).toMatchObject({ kind: "result", result: { exitCode: 7 } });
    // The stored identity is host-clock; the guest receipt carries the same
    // ownership on the guest clock, so absolute deadlines may differ by the
    // prepare round trip, never by more.
    const { heartbeatDeadline, guestDeadline, guestNow, ...ownership } = receipt.identity;
    void guestNow;
    const { heartbeatDeadline: _h, guestDeadline: _g, ...fullOwnership } = full as unknown as Record<string, unknown>;
    void _h; void _g;
    expect(ownership).toEqual(fullOwnership);
    for (const [key, want] of [["heartbeatDeadline", full.heartbeatDeadline], ["guestDeadline", full.guestDeadline]] as const) {
      expect(Math.abs((receipt.identity[key] as number) - want)).toBeLessThan(10_000);
    }
    // Re-sending a delivered start cannot execute it again.
    await expect(guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} }))
      .rejects.toThrow();
  }, 20_000);

  it("primes the guest cargo cache before an offline prepare, and fails the prepare when the fetch fails", async () => {
    const offline = cmd();
    offline.tool = "cargo";
    offline.argv = ["test", "--offline"];
    async function primingGuest(exitCode: number, tag: string, toolchain: string | null = null) {
      const stub = path.join(ssh.root, `cargo-stub-${tag}`);
      await mkdir(stub);
      await writeFile(path.join(stub, "cargo"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${stub}/argv\nexit ${exitCode}\n`, { mode: 0o755 });
      const priming = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
        stateRoot: ssh.root, workspace: async () => ssh.root, executable: "cargo", path: `${stub}:/usr/bin:/bin`,
        cargoToolchain: () => toolchain });
      return { priming, stub };
    }
    // A failing fetch fails the prepare before any supervisor exists, so the
    // command falls back locally. No cgroup delegation needed for this path.
    {
      const { priming, stub } = await primingGuest(3, "fail");
      try {
        await expect(priming.prepare(ssh.session.sandboxId, offline)).rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE" });
        expect(await readFile(path.join(stub, "argv"), "utf8")).toBe("fetch\n--locked\n--config\nregistry.global-credential-providers=[]\n");
      } finally {
        await priming.shutdown();
      }
    }
    // --frozen is --locked plus --offline, so it primes the same way.
    {
      const frozen = cmd();
      frozen.tool = "cargo";
      frozen.argv = ["test", "--frozen"];
      const { priming, stub } = await primingGuest(3, "frozen");
      try {
        await expect(priming.prepare(ssh.session.sandboxId, frozen)).rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE" });
        expect(await readFile(path.join(stub, "argv"), "utf8")).toBe("fetch\n--locked\n--config\nregistry.global-credential-providers=[]\n");
      } finally {
        await priming.shutdown();
      }
    }
    const capabilities = await guest.preflight(ssh.session.sandboxId, cmd());
    if (!capabilities.cgroupV2Delegated) return;
    const { priming, stub } = await primingGuest(0, "ok", "+stable");
    try {
      const identity = await priming.prepare(ssh.session.sandboxId, offline);
      expect(identity.cgroupPath.startsWith(`${parent}/`)).toBe(true);
      // The host-validated toolchain selector travels into the fixed fetch argv.
      expect(await readFile(path.join(stub, "argv"), "utf8")).toBe("+stable\nfetch\n--locked\n--config\nregistry.global-credential-providers=[]\n");
    } finally {
      await priming.shutdown();
    }
  }, 20_000);

  it("renews guest interest from a duration and rejects arbitrary extensions", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    const { full } = await identity(cmd());
    // Durations cross the boundary, never absolute timestamps: the renewal
    // lands on the guest clock however far apart the two clocks are.
    const before = Date.now();
    await guest.heartbeat(ssh.session.sandboxId, full);
    const stored = (await guest.inspect(ssh.session.sandboxId, full)).identity.heartbeatDeadline;
    expect(stored).toBeGreaterThan(before);
    expect(stored).toBeLessThanOrEqual(Date.now() + 30_000);
    // A tampered far-future absolute in the identity is ignored: the renewal
    // still lands on the guest clock and cannot extend interest past 30 s.
    await guest.heartbeat(ssh.session.sandboxId, { ...full, heartbeatDeadline: Date.now() + 600_000 });
    const capped = (await guest.inspect(ssh.session.sandboxId, full)).identity.heartbeatDeadline;
    expect(capped).toBeLessThanOrEqual(Date.now() + 30_000);
    // The guest refuses out-of-range renewals at the RPC boundary.
    const raw = guest as unknown as { call: (sandboxId: string, action: string, identity: unknown,
      extra?: Record<string, unknown>) => Promise<unknown> };
    await expect(raw.call(ssh.session.sandboxId, "heartbeat", full, { renewMs: 120_000 })).rejects.toThrow();
    await expect(raw.call(ssh.session.sandboxId, "heartbeat", full, { renewMs: 0 })).rejects.toThrow();
  });

  it("prepares and heartbeats across a skewed guest clock and keeps the real exit code", { ...CGROUP_GATED, timeout: 40_000 }, async (ctx) => {
    await requireDelegation(ctx);
    // A resumed VM's clock can sit seconds behind or ahead until chrony
    // corrects it. Shifting the guest's time.time uniformly emulates that
    // skew in the real supervisor; absolute deadlines must still neither
    // fail heartbeats nor refuse prepare.
    for (const skewSeconds of [-2, 2]) {
      const skewed = OFFLOAD_SSH_SCRIPT.split("time.time()")
        .join(skewSeconds < 0 ? `(time.time() - ${-skewSeconds})` : `(time.time() + ${skewSeconds})`);
      const skewedGuest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
        stateRoot: ssh.root, workspace: async () => ssh.root, executable: "/bin/sh",
        args: () => ["-c", "sleep 3; exit 9"], script: skewed });
      try {
        const command = cmd(30_000);
        const boot = await skewedGuest.bootId(ssh.session.sandboxId);
        const lifecycle = new OffloadLifecycle(skewedGuest, Date.now, { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) });
        const full = await lifecycle.prepare(ssh.session.sandboxId, command, { companyId: command.companyId,
          runId: command.runId, commandId: command.commandId, digest: commandDigest(command),
          sandboxId: ssh.session.sandboxId, guestBootId: boot, journalGeneration: 1 });
        const output: string[] = [];
        const pending = lifecycle.run(full, command,
          (vm, c, context) => skewedGuest.runCommand(vm, c, context),
          async (_stream, bytes) => { output.push(Buffer.from(bytes).toString()); });
        for (let n = 0; n < 3; n += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
          await lifecycle.heartbeat(full);
        }
        const result = await pending;
        expect(result).toMatchObject({ exitCode: 9 });
        expect(result).not.toMatchObject({ cancelled: true, timedOut: true });
        expect(await skewedGuest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
      } finally {
        await skewedGuest.shutdown();
      }
    }
  });

  it("rejects stale boot/group identities before signalling any process", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    const { full } = await identity(cmd());
    await expect(guest.kill(ssh.session.sandboxId, { ...full, guestBootId: "rebooted" })).rejects.toThrow();
    await expect(guest.term(ssh.session.sandboxId, { ...full, processGroupId: full.processGroupId + 1 })).rejects.toThrow();
    await guest.kill(ssh.session.sandboxId, full);
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
  });

  it("cancels a TERM-resistant subtree without touching the shared SSH master", { ...CGROUP_GATED, timeout: 20_000 }, async (ctx) => {
    await requireDelegation(ctx);
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
  });

  it("holds uncertainty rather than polling forever after a lost guest supervisor", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    const command = cmd();
    const { full } = await identity(command);
    await guest.armDeadline(ssh.session.sandboxId, full);
    const state = JSON.parse(await readFile(path.join(ssh.root, path.basename(full.cgroupPath), "state"), "utf8"));
    // This PID came from this test's freshly prepared private state directory.
    process.kill(state.supervisorPid, "SIGKILL");
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    await expect(guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} }))
      .rejects.toThrow();
  });

  it("fails closed on output overflow rather than publishing a truncated success receipt", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3", path: "/usr/bin:/bin",
      args: () => ["-c", "import sys; sys.stdout.buffer.write(b'x' * 1100000)"] });
    const command = cmd();
    const { lifecycle, full } = await identity(command);
    await expect(lifecycle.run(full, command, (vm, c, context) => guest.runCommand(vm, c, context), async () => {}))
      .rejects.toMatchObject({ code: "OFFLOAD_OUTPUT_LIMIT" });
    expect(await guest.verifyEmpty(ssh.session.sandboxId, full)).toBe(true);
    expect(await guest.receipt(full)).toBe(null);
  });

  it("records timeout when the outside watchdog kills before the supervisor observes expiry", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3",
      args: () => ["-c", "import os,time; os.close(1); os.close(2); time.sleep(60)"] });
    const command = cmd(2_000);
    const { full } = await identity(command);
    await guest.armDeadline(ssh.session.sandboxId, full);
    const state = JSON.parse(await readFile(path.join(ssh.root, path.basename(full.cgroupPath), "state"), "utf8"));
    const pending = guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} });
    let paused = false;
    try {
      // Pause only this fixture's owned supervisor in its output wait, after
      // the loop's expiry check. The independent watchdog must enforce expiry
      // and the resumed supervisor must preserve that timeout in its receipt.
      await expect.poll(async () => {
        const saved = JSON.parse(await readFile(path.join(ssh.root, path.basename(full.cgroupPath), "state"), "utf8"));
        const wait = await readFile(`/proc/${state.supervisorPid}/wchan`, "utf8");
        const fdRoot = `/proc/${state.supervisorPid}/fd`;
        const descriptors = await Promise.all((await readdir(fdRoot)).map((fd) => readlink(`${fdRoot}/${fd}`).catch(() => "")));
        if (!saved.started || !/ep_?poll/.test(wait) || descriptors.some((fd) => fd.startsWith("pipe:"))) return false;
        process.kill(state.supervisorPid, "SIGSTOP");
        paused = true;
        return true;
      }).toBe(true);
      await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full), { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => (await readFile(`/proc/${full.processGroupId}/stat`, "utf8")).includes(") Z"))
        .toBe(true);
    } finally {
      if (paused) process.kill(state.supervisorPid, "SIGCONT");
    }
    expect(await pending).toMatchObject({ exitCode: 124 });
    expect(await guest.receipt(full)).toMatchObject({ result: { exitCode: 124 } });
  });

  it("guest watchdog kills detached descendants without a host cancellation timer", { ...CGROUP_GATED, timeout: 15_000 }, async (ctx) => {
    await requireDelegation(ctx);
    const marker = path.join(ssh.root, "payload-started");
    guest = new SshOffloadGuest({ ssh: ssh.manager, session: async () => ssh.session, cgroupParent: parent,
      stateRoot: ssh.root, workspace: async () => ssh.root, executable: "python3", args: () => ["-c",
        `import os,time; open(${JSON.stringify(marker)},'w').close(); p=os.fork(); os.setsid() if p == 0 else None; time.sleep(60)`] });
    const command = cmd(1_500);
    const { full } = await identity(command);
    expect(await guest.armDeadline(ssh.session.sandboxId, full)).toEqual({ verified: true, outsideCommandCgroup: true });
    const pending = guest.runCommand(ssh.session.sandboxId, command, { identity: full, output: async () => {} });
    // The default 1s poll is shorter than SSH dispatch plus python startup on a CI runner.
    await expect.poll(() => readFile(marker, "utf8").catch(() => null), { timeout: 5_000 }).toBe("");
    expect(await pending).toMatchObject({ exitCode: 124 });
    await expect.poll(() => guest.verifyEmpty(ssh.session.sandboxId, full), { timeout: 5_000 }).toBe(true);
  });
});
