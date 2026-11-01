import { describe, expect, it, vi } from "vitest";
import { SshOffloadGuest } from "./offload-ssh.js";
import { profileGuestEnv } from "./offload-ssh-runtime.js";
import type { OffloadCommand } from "./offload.js";

function command(over: Partial<OffloadCommand> = {}): OffloadCommand {
  return {
    commandId: "7d82278c-2ba7-4e68-96ab-a2cc10b697af",
    companyId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    cardId: "",
    repoId: "repo:https://github.com/example/app",
    profileId: "node-public-1",
    tool: "node",
    runner: "npm",
    argv: ["run", "test"],
    cwdRelative: ".",
    env: {},
    ...over,
  };
}

function stubGuest() {
  const seen: unknown[] = [];
  const ssh = {
    runStream: vi.fn(async (_session: unknown, _cmd: string, opts: { stdin?: AsyncIterable<Uint8Array> }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of opts.stdin ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push(input);
      // The cache-priming fetch carries no supervisor program; only the
      // prepare does. A nonzero exit here would fail the prepare.
      if (!("program" in input)) {
        return { exitCode: 0, timedOut: false, signal: null, stdout: JSON.stringify({ exitCode: 0 }) };
      }
      return {
        exitCode: 0, timedOut: false, signal: null,
        stdout: JSON.stringify({ guestBootId: "boot-1", processGroupId: 1, cgroupPath: "/sys/fs/cgroup/x", journalGeneration: 1, heartbeatDeadline: 1, guestDeadline: 1 }),
      };
    }),
  };
  const guest = new SshOffloadGuest({
    ssh: ssh as never,
    session: async () => ({} as never),
    cgroupParent: "/sys/fs/cgroup",
    workspace: async () => "/tmp/work",
    allowedEnv: (cmd) => ((cmd.tool ?? "cargo") === "cargo" ? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"] : []),
    profileEnv: profileGuestEnv,
  });
  return { guest, ssh, seen };
}

describe("node/python guest prepare", () => {
  it("runs the package runner as the guest executable", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command());
    const input = seen[0] as Record<string, unknown>;
    expect(input).toMatchObject({ executable: "npm", env: {} });
    expect(input.args).toEqual(["run", "test"]);
  });

  it("rejects any env on node/python commands", async () => {
    const { guest, ssh } = stubGuest();
    await expect(guest.prepare("vm-1", command({ env: { FOO: "bar" } })))
      .rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE" });
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("keeps the cargo env contract", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command({ tool: "cargo", runner: "cargo", profileId: "rust-public-1",
      argv: ["test"], env: { CARGO_TERM_COLOR: "never" } }));
    expect(seen[0] as Record<string, unknown>).toMatchObject({ executable: "cargo" });
    await expect(guest.prepare("vm-1", command({ tool: "cargo", runner: "cargo", profileId: "rust-public-1",
      argv: ["test"], env: { RUSTFLAGS: "-D warnings" } })))
      .rejects.toMatchObject({ code: "OFFLOAD_GUEST_INELIGIBLE" });
  });

  it("applies the server-owned rust-public-1 build env under the request env", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command({ tool: "cargo", runner: "cargo", profileId: "rust-public-1",
      argv: ["test", "--locked"], env: { CARGO_TERM_COLOR: "never" } }));
    expect((seen[0] as { env: Record<string, string> }).env).toEqual({
      CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0", CARGO_TERM_COLOR: "never",
    });
    // Node commands never pick up the cargo profile env.
    await guest.prepare("vm-1", command());
    expect((seen[1] as { env: Record<string, string> }).env).toEqual({});
  });

  it("primes the guest cache with a fixed fetch before an offline prepare", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command({ tool: "cargo", runner: "cargo", profileId: "rust-public-1",
      argv: ["test", "--offline"] }));
    expect(seen[0]).toMatchObject({ executable: "cargo", cwd: "/tmp/work",
      path: "/home/user/.cargo/bin:/usr/local/bin:/usr/bin:/bin" });
    expect(seen[0]).not.toHaveProperty("program");
    expect(seen[1]).toMatchObject({ executable: "cargo", program: expect.any(String) });
  });

  it("runs a uv python command inside the checkout venv with only VIRTUAL_ENV set", async () => {
    const seen: unknown[] = [];
    const ssh = {
      runStream: vi.fn(async (_session: unknown, _cmd: string, opts: { stdin?: AsyncIterable<Uint8Array> }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of opts.stdin ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        return {
          exitCode: 0, timedOut: false, signal: null,
          stdout: JSON.stringify({ guestBootId: "boot-1", processGroupId: 1, cgroupPath: "/sys/fs/cgroup/x", journalGeneration: 1, heartbeatDeadline: 1, guestDeadline: 1 }),
        };
      }),
    };
    const guest = new SshOffloadGuest({
      ssh: ssh as never,
      session: async () => ({} as never),
      cgroupParent: "/sys/fs/cgroup",
      workspace: async () => "/tmp/work",
      allowedEnv: () => [],
      uvVenvRoot: async () => "/tmp/guest-checkout",
    });
    await guest.prepare("vm-1", command({ tool: "python", runner: "python", profileId: "python-public-1",
      argv: ["-m", "pytest", "tests/"] }));
    const input = seen[0] as Record<string, unknown>;
    expect(input).toMatchObject({ executable: "/tmp/guest-checkout/.venv/bin/python",
      env: { VIRTUAL_ENV: "/tmp/guest-checkout/.venv" } });
    expect(input.args).toEqual(["-m", "pytest", "tests/"]);
  });

  it("keeps a non-uv python command on the system runner", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command({ tool: "python", runner: "pytest", profileId: "python-public-1",
      argv: ["tests/"] }));
    expect(seen[0] as Record<string, unknown>).toMatchObject({ executable: "pytest", env: {} });
  });

  it("activates the checkout venv for child processes", async () => {
    const seen: unknown[] = [];
    const ssh = {
      runStream: vi.fn(async (_session: unknown, _cmd: string, opts: { stdin?: AsyncIterable<Uint8Array> }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of opts.stdin ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        return {
          exitCode: 0, timedOut: false, signal: null,
          stdout: JSON.stringify({ guestBootId: "boot-1", processGroupId: 1, cgroupPath: "/sys/fs/cgroup/x", journalGeneration: 1, heartbeatDeadline: 1, guestDeadline: 1 }),
        };
      }),
    };
    const guest = new SshOffloadGuest({
      ssh: ssh as never,
      session: async () => ({} as never),
      cgroupParent: "/sys/fs/cgroup",
      workspace: async () => "/tmp/work",
      allowedEnv: () => [],
      uvVenvRoot: async () => "/tmp/guest-checkout",
    });
    await guest.prepare("vm-1", command({ tool: "python", runner: "python", profileId: "python-public-1",
      argv: ["-m", "pytest", "tests/"] }));
    const input = seen[0] as Record<string, unknown>;
    expect(input).toMatchObject({ executable: "/tmp/guest-checkout/.venv/bin/python",
      env: { VIRTUAL_ENV: "/tmp/guest-checkout/.venv" } });
    expect(input.path as string).toBe("/tmp/guest-checkout/.venv/bin:/home/user/.cargo/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("leaves the guest PATH alone without a uv venv", async () => {
    const { guest, seen } = stubGuest();
    await guest.prepare("vm-1", command({ tool: "python", runner: "pytest", profileId: "python-public-1",
      argv: ["tests/"] }));
    const input = seen[0] as Record<string, unknown>;
    expect(input.env).toEqual({});
    expect(input.path as string).toBe("/home/user/.cargo/bin:/usr/local/bin:/usr/bin:/bin");
  });
});
