import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshOffloadGuest } from "./offload-ssh.js";
import type { OffloadCommand } from "./offload.js";
import { responseError } from "./test-support/fake-boat.js";
import { command, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";

// Pool isolation: without an explicit host trust domain, a command's trust
// domain is its execution workspace, so pool VMs are never shared across
// workspaces. Ephemeral repos get one deleted-after-use VM per command.
describe("pool workspace isolation", () => {
  let s: Fixture;
  beforeEach(async () => { s = await fixture(); });
  afterEach(async () => { await s.dispose(); });

  const untrusted = { trustDomainId: undefined as unknown as string };

  it("gives two workspaces of one repo different VMs: the second creates, never reuses warm", async () => {
    const ex = s.make({ maxOffloadVms: 2 });
    const first = await s.execute(command("ws-a", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    const second = await s.execute(command("ws-b", { ...untrusted, executionWorkspaceId: "workspace-b" }), ex);
    expect(first).toMatchObject({ status: "completed", warm: "cold" });
    expect(second).toMatchObject({ status: "completed", warm: "cold" });
    expect(s.starts[1]!.sandboxId).not.toBe(s.starts[0]!.sandboxId);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("resume")).toHaveLength(0);
  });

  it("still reuses a warm VM for repeat commands from the same workspace", async () => {
    const ex = s.make({ maxOffloadVms: 2 });
    await s.execute(command("one", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    const second = await s.execute(command("two", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    expect(second).toMatchObject({ status: "completed", warm: "warm" });
    expect(s.boat.callsOf("create")).toHaveLength(1);
  });

  it("deletes a retired incompatible VM at the provider instead of forgetting its disk", async () => {
    await s.execute(command("first"));
    const old = s.starts[0]!.sandboxId;
    expect(await s.execute(command("other", { trustDomainId: "untrusted-fork" })))
      .toMatchObject({ status: "completed", warm: "cold" });
    expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([old]);
    expect(s.boat.boxes.has(old)).toBe(false);
  });

  it("ephemeral policy: exactly one create and one delete per command, never a resume", async () => {
    const ex = s.make({ maxOffloadVms: 2, ephemeralRepos: ["repo-a"] });
    await s.execute(command("eph-1", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(1);
    const second = await s.execute(command("eph-2", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    expect(second).toMatchObject({ status: "completed", warm: "cold" });
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(2);
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect(s.starts[1]!.sandboxId).not.toBe(s.starts[0]!.sandboxId);
  });

  it("ephemeral deletes close the account reservation, so later commands stay admissible", async () => {
    const ex = s.make({ maxOffloadVms: 2, ephemeralRepos: ["repo-a"] });
    for (const id of ["eph-a", "eph-b", "eph-c"]) {
      expect(await s.execute(command(id, { ...untrusted, executionWorkspaceId: "workspace-a" }), ex))
        .toMatchObject({ status: "completed", warm: "cold" });
    }
    const docs = Object.values(await s.state.all()) as Array<Record<string, unknown>>;
    const account = docs.find((doc) => Array.isArray(doc.intents)) as
      { intents: Array<{ sandboxId: string | null; active: boolean; status: string }> } | undefined;
    expect(account).toBeDefined();
    const deleted = s.starts.map((start) => start.sandboxId);
    for (const intent of account!.intents) {
      if (intent.sandboxId && deleted.includes(intent.sandboxId)) {
        expect(intent.active).toBe(false);
      }
    }
  });

  it("a failed ephemeral delete stops the VM and sweep retries the delete", async () => {
    const ex = s.make({ maxOffloadVms: 2, ephemeralRepos: ["repo-a"] });
    s.boat.failNext("deleteSandbox", responseError(503, { code: "http_503" }));
    expect(await s.execute(command("eph-fail", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex))
      .toMatchObject({ status: "completed" });
    const orphan = s.starts[0]!.sandboxId;
    expect(s.boat.boxes.has(orphan)).toBe(true);
    expect(s.boat.callsOf("stop").map((call) => call.args.sandboxId)).toContain(orphan);
    await ex.sweep();
    expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId)).toEqual([orphan, orphan]);
    expect(s.boat.boxes.has(orphan)).toBe(false);
  });

  it("a delete that succeeds on shutdown retry clears the earlier shutdown failure", async () => {
    const ex = s.make({ maxOffloadVms: 2, ephemeralRepos: ["repo-a"] });
    s.boat.failNext("deleteSandbox", responseError(503, { code: "http_503" }));
    expect(await s.execute(command("eph-del", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex))
      .toMatchObject({ status: "completed" });
    const orphan = s.starts[0]!.sandboxId;
    s.boat.failNext("deleteSandbox", responseError(503, { code: "http_503" }));
    await expect(ex.shutdown()).rejects.toThrow(/OFFLOAD_SHUTDOWN_INCOMPLETE/);
    expect(s.boat.boxes.has(orphan)).toBe(true);
    await expect(ex.shutdown()).resolves.toBeUndefined();
    expect(s.boat.boxes.has(orphan)).toBe(false);
    expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId))
      .toEqual([orphan, orphan, orphan]);
    await expect(ex.shutdown()).resolves.toBeUndefined();
  });

  it("setEphemeralRepos applies the live policy to an existing pool", async () => {
    const ex = s.make({ maxOffloadVms: 2 });
    await s.execute(command("before", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(0);
    ex.setEphemeralRepos(["repo-a"]);
    const after = await s.execute(command("after", { ...untrusted, executionWorkspaceId: "workspace-a" }), ex);
    expect(after).toMatchObject({ status: "completed", warm: "cold" });
    expect(s.boat.callsOf("deleteSandbox").map((call) => call.args.sandboxId))
      .toEqual([s.starts[1]!.sandboxId]);
  });
});

// Guest environment hardening: root-owned PATH only, fresh HOME per command.
describe("guest command environment", () => {
  async function prepareCapture(commandId: string) {
    const captured: Array<Record<string, unknown>> = [];
    const ssh = {
      runStream: vi.fn(async (_session: unknown, _remote: string, opts: { stdin?: Readable }) => {
        let stdin = "";
        if (opts.stdin) for await (const chunk of opts.stdin) stdin += String(chunk);
        captured.push(JSON.parse(stdin) as Record<string, unknown>);
        const identity = {
          companyId: "company", runId: "run", commandId, digest: "d", sandboxId: "vm-1",
          guestBootId: "boot", processGroupId: 1,
          cgroupPath: `/sys/fs/cgroup/parent/paperclip-boat-${"a".repeat(32)}`,
          journalGeneration: 1, heartbeatDeadline: 0, guestDeadline: 0,
        };
        return { exitCode: 0, timedOut: false, signal: null, stdout: JSON.stringify(identity), stderr: "" };
      }),
    };
    const guest = new SshOffloadGuest({
      ssh: ssh as never,
      session: async () => ({}) as never,
      cgroupParent: "/sys/fs/cgroup/parent",
      stateRoot: "/tmp/state",
      workspace: async () => "/tmp/state/mirror",
    });
    const cmd: OffloadCommand = {
      commandId, companyId: "company", runId: "run", cardId: "card",
      repoId: "repo", profileId: "rust-public-1", tool: "cargo", runner: "cargo",
      argv: ["test"], env: {}, timeoutMs: 1000,
    };
    await guest.prepare("vm-1", cmd);
    return captured[0]!;
  }

  it("default PATH contains no /home path and HOME differs per command", async () => {
    const one = await prepareCapture("00000000-0000-4000-8000-000000000001");
    const two = await prepareCapture("00000000-0000-4000-8000-000000000002");
    expect(String(one.path)).not.toContain("/home/");
    expect(String(one.path)).toBe("/usr/local/bin:/usr/bin:/bin");
    const envOne = one.env as Record<string, string>;
    const envTwo = two.env as Record<string, string>;
    expect(envOne.HOME).toMatch(/^\/tmp\/state\/paperclip-boat-home-[0-9a-f]{32}$/);
    expect(envTwo.HOME).not.toBe(envOne.HOME);
    // The crate cache is per-VM, outside HOME: stable across commands on one
    // VM so priming and warm builds keep working, never under a command HOME.
    expect(envOne.CARGO_HOME).toMatch(/^\/tmp\/state\/paperclip-boat-toolchain-[0-9a-f]{32}\/cargo$/);
    expect(envTwo.CARGO_HOME).toBe(envOne.CARGO_HOME);
    expect(envOne.CARGO_HOME.startsWith(envOne.HOME)).toBe(false);
  });
});
