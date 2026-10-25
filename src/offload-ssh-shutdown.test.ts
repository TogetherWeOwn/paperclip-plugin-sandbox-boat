import { describe, expect, it, vi } from "vitest";
import { SshOffloadGuest } from "./offload-ssh.js";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import type { SshManager, SshSession } from "./ssh.js";
import type { ExecutionIdentity } from "./offload-lifecycle.js";
import type { OffloadCommand } from "./offload.js";

const command: OffloadCommand = { companyId: "company", runId: "run", commandId: "command", cardId: "card",
  repoId: "repo", profileId: "test", argv: ["test"] };

function fixture() {
  const actions = new Map(["prepare", "empty", "kill", "retire", "receipt"].map((action) => [
    buildRemoteCommand(`exec python3 -I -c ${shellQuote(OFFLOAD_SSH_SCRIPT)} ${shellQuote(action)}`), action,
  ]));
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  let serial = 0;
  let empty: unknown = true;
  const session = { sandboxId: "vm" } as SshSession;
  const ssh = {
    masterAlive: vi.fn(() => true),
    runStream: vi.fn(async (_session, remote, options) => {
      const action = actions.get(remote);
      if (!action) throw new Error("unexpected RPC");
      let text = "";
      for await (const chunk of options.stdin) text += String(chunk);
      const input = JSON.parse(text);
      calls.push({ action, input });
      if (action === "empty" && empty instanceof Error) throw empty;
      const result = action === "prepare" ? { ...input.base, guestBootId: "boot", processGroupId: ++serial,
        cgroupPath: `/sys/fs/cgroup/test/paperclip-boat-${serial.toString(16).padStart(32, "0")}`,
        journalGeneration: 1, heartbeatDeadline: Date.now() + 30_000, guestDeadline: Date.now() + 60_000 }
        : action === "empty" ? empty : action === "receipt" ? { kind: "result", identity: input.identity } : true;
      return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify(result), stderr: "" };
    }),
  } satisfies Pick<SshManager, "masterAlive" | "runStream">;
  const guest = new SshOffloadGuest({ ssh: ssh as unknown as SshManager, session: async () => session,
    cgroupParent: "/sys/fs/cgroup/test", workspace: async () => "/work" });
  return { guest, calls, setEmpty: (value: unknown) => { empty = value; } };
}

describe("guest shutdown tracks only unverified subtrees", () => {
  it("does not replay cleanup for 1000 verified-empty commands and preserves receipt access", async () => {
    const { guest, calls } = fixture();
    let last!: ExecutionIdentity;
    for (let i = 0; i < 1000; i++) {
      last = await guest.prepare("vm", { ...command, commandId: String(i) }) as ExecutionIdentity;
      expect(await guest.verifyEmpty("vm", last)).toBe(true);
    }
    expect(await guest.receipt(last)).toMatchObject({ kind: "result", identity: last });
    calls.length = 0;
    await guest.shutdown();
    expect(calls).toEqual([]);
  });

  it.each([false, null, "true", new Error("lost transport")])("retains cleanup ownership when empty verification returns %j", async (answer) => {
    const { guest, calls, setEmpty } = fixture();
    const active = await guest.prepare("vm", command);
    const uncertain = await guest.prepare("vm", command);
    setEmpty(answer);
    if (answer instanceof Error) await expect(guest.verifyEmpty("vm", uncertain)).rejects.toThrow("lost transport");
    else await guest.verifyEmpty("vm", uncertain);
    calls.length = 0;
    await guest.shutdown();
    expect(calls.map(({ action, input }) => [action, input.identity])).toEqual([
      ["kill", active], ["retire", active], ["kill", uncertain], ["retire", uncertain],
    ]);
    calls.length = 0;
    await guest.shutdown();
    expect(calls).toEqual([]);
  });
});
