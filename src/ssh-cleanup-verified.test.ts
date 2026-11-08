// runSupervised must tell callers whether remote cleanup was verified. A
// suppressed cleanup failure (run() on a nonzero payload exit) reports
// cleanupVerified=false; a completed cancel/finalize reports true. Only the
// ssh binary is a test double: each spawn consumes the next scripted shell.
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  actual: null as typeof spawn | null,
  scripts: [] as string[],
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  transport.actual = actual.spawn;
  return {
    ...actual,
    spawn: (command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess => {
      if (command !== "ssh" || !transport.actual) return actual.spawn(command, args, options);
      const script = transport.scripts.shift();
      if (script === undefined) throw new Error("unexpected extra ssh spawn");
      return transport.actual("sh", ["-c", script], options);
    },
  };
});

import { SshManager } from "./ssh.js";
import type { SshSession } from "./ssh.js";

const warnings: string[] = [];
const session = {
  sandboxId: "sb",
  endpoint: { host: "127.0.0.1", port: 22, user: "u" },
  controlPath: "/tmp/ctl-unused",
  knownHostsPath: "/tmp/kh-unused",
  connectTimeoutSec: 5,
} as unknown as SshSession;

function manager(): SshManager {
  const ssh = new SshManager({ info: () => undefined, warn: (m) => void warnings.push(m) });
  vi.spyOn(ssh, "ensureKey").mockResolvedValue({ privateKeyPath: "/tmp/unused-key", publicKey: "unused" });
  return ssh;
}

beforeEach(() => {
  transport.scripts.length = 0;
  warnings.length = 0;
});

describe("SshExecutionResult.cleanupVerified", () => {
  it("is false when a nonzero payload exit has its cleanup failure suppressed", async () => {
    transport.scripts.push("exit 1", "echo nope >&2; exit 1");
    const result = await manager().runStream(session, "false", { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, cleanupVerified: false });
    expect(warnings).toHaveLength(1);
    expect(transport.scripts).toHaveLength(0);
  });

  it("is true when a nonzero payload exit is followed by verified cleanup", async () => {
    transport.scripts.push("exit 1", "exit 0");
    const result = await manager().runStream(session, "false", { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, cleanupVerified: true });
    expect(warnings).toHaveLength(0);
  });

  it("is true when a timed-out payload is followed by verified cancel", async () => {
    transport.scripts.push("exec sleep 5", "exit 0");
    const result = await manager().run(session, "sleep 5", { timeoutMs: 100 });
    expect(result).toMatchObject({ timedOut: true, cleanupVerified: true });
  });

  it("is false when a timed-out payload's cancel fails", async () => {
    transport.scripts.push("exec sleep 5", "exit 3");
    const result = await manager().run(session, "sleep 5", { timeoutMs: 100 });
    expect(result).toMatchObject({ timedOut: true, cleanupVerified: false });
  });

  it("still throws when a successful runStream payload has failed cleanup", async () => {
    transport.scripts.push("exit 0", "exit 1");
    await expect(manager().runStream(session, "true", { timeoutMs: 5_000 })).rejects.toThrow(/Remote command cleanup failed/);
  });
});
