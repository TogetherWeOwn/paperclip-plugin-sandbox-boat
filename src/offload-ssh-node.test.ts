import { describe, expect, it, vi } from "vitest";
import { SshOffloadGuest } from "./offload-ssh.js";
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
    allowedEnv: (cmd) => ((cmd.tool ?? "cargo") === "cargo" ? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"] : []),
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
});
