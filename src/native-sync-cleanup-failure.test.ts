// Cleanup failure after payload success must reject through runStream.
// Production SshManager; only the ssh transport is a test double, failing the
// finalization channel while the payload channel succeeds.
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  actual: null as typeof spawn | null,
  calls: 0,
  payload: "success" as "success" | "error" | "timeout",
  cleanup: "success" as "success" | "nonzero" | "timeout" | "throw",
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  transport.actual = actual.spawn;
  return {
    ...actual,
    spawn: (command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess => {
      if (command !== "ssh" || !transport.actual) return actual.spawn(command, args, options);
      transport.calls += 1;
      const finalization = transport.calls % 2 === 0;
      const mode = finalization ? transport.cleanup : transport.payload;
      if (mode === "throw") {
        return transport.actual("/nonexistent-ssh-test-only", [], options);
      }
      if (mode === "timeout") {
        return transport.actual("sh", ["-c", "sleep 15"], options);
      }
      if (!finalization && mode === "error") {
        return transport.actual("sh", ["-c", "printf fast; exit 19"], options);
      }
      if (finalization && mode === "nonzero") {
        // Settle stderr before exit: runStreamProcess detaches the ssh
        // stderr pipe on exit, so a write racing exit looks like a stream
        // failure instead of the cleanup diagnostic under test.
        return transport.actual("sh", ["-c", "printf 'cleanup boom' >&2; sleep 0.3; exit 42"], options);
      }
      return transport.actual("sh", ["-c", "printf ok; exit 0"], options);
    },
  };
});

import { SshManager } from "./ssh.js";
import type { SshSession } from "./ssh.js";

let manager: SshManager;
let session: SshSession;
let warnings: string[];

beforeEach(() => {
  transport.calls = 0;
  transport.payload = "success";
  transport.cleanup = "success";
  warnings = [];
  const logger = {
    info() {},
    warn: (message: string) => {
      warnings.push(message);
    },
  };
  class KeylessManager extends SshManager {
    override async ensureKey() {
      return { privateKeyPath: "/dev/null", publicKey: "ssh-ed25519 AAAATESTONLY" };
    }
  }
  manager = new KeylessManager(logger);
  session = {
    sandboxId: "test-only",
    endpoint: { host: "127.0.0.1", port: 22, user: "test", hostKey: "ssh-ed25519 AAAATESTONLY" },
    knownHostsPath: "/dev/null",
    controlPath: "/tmp/test-only-ctl",
    master: null,
    tunnel: "disabled",
    tunnelSpec: null,
    tunnelError: null,
    connectTimeoutSec: 2,
    lastMasterStartAt: 0,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("payload exit 0 with cleanup exit 42 rejects with the cleanup diagnostic", async () => {
  transport.payload = "success";
  transport.cleanup = "nonzero";

  const error = await manager.runStream(session, "printf payload", { timeoutMs: 3000 }).then(
    () => null,
    (reason: unknown) => reason as Error,
  );

  expect(error, "cleanup failure after success must reject").toBeInstanceOf(Error);
  expect(String(error)).toMatch(/cleanup failed/i);
  expect(String(error)).toContain("cleanup boom");
  expect(transport.calls, "payload then finalization").toBe(2);
  expect(warnings.join("\n")).toMatch(/cleanup failed/i);
});

it("payload exit 0 with cleanup timeout rejects with the cleanup diagnostic", async () => {
  transport.payload = "success";
  transport.cleanup = "timeout";

  const error = await manager.runStream(session, "printf payload", { timeoutMs: 3000 }).then(
    () => null,
    (reason: unknown) => reason as Error,
  );

  expect(error, "cleanup timeout after success must reject").toBeInstanceOf(Error);
  expect(String(error)).toMatch(/cleanup failed/i);
  expect(transport.calls).toBe(2);
  expect(warnings.join("\n")).toMatch(/cleanup failed/i);
}, 20000);

it("payload exit 0 with thrown cleanup transport rejects", async () => {
  transport.payload = "success";
  transport.cleanup = "throw";

  const error = await manager.runStream(session, "printf payload", { timeoutMs: 3000 }).then(
    () => null,
    (reason: unknown) => reason as Error,
  );

  expect(error, "thrown cleanup transport after success must reject").toBeInstanceOf(Error);
  expect(transport.calls).toBe(2);
  expect(warnings.join("\n")).toMatch(/cleanup failed/i);
});

it("control: payload error with failed cleanup preserves the original payload result", async () => {
  transport.payload = "error";
  transport.cleanup = "nonzero";

  const result = await manager.runStream(session, "printf payload; exit 19", { timeoutMs: 3000 });

  expect(result).toMatchObject({ exitCode: 19, timedOut: false, stdout: "fast" });
  expect(transport.calls).toBe(2);
  expect(warnings.join("\n")).toMatch(/cleanup failed/i);
});

it("control: payload timeout with failed cleanup preserves the timeout", async () => {
  transport.payload = "timeout";
  transport.cleanup = "nonzero";

  const result = await manager.runStream(session, "sleep 15", { timeoutMs: 400 });

  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
  expect(transport.calls).toBe(2);
  expect(warnings.join("\n")).toMatch(/cleanup failed/i);
}, 15000);

it("control: payload success with cleanup success resolves exit 0", async () => {
  transport.payload = "success";
  transport.cleanup = "success";

  const result = await manager.runStream(session, "printf payload", { timeoutMs: 3000 });

  expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "ok" });
  expect(transport.calls).toBe(2);
  expect(warnings).toEqual([]);
});
