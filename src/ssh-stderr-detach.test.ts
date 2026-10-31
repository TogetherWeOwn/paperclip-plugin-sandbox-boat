// A multiplexed ssh client hands its stderr to the control master, so the pipe
// can stay open after the client exits. runStreamProcess detaches stderr on
// exit; that detach must not turn a successful command into a stream failure.
// Only the ssh binary is a test double: it exits while a background child
// still holds its stderr, which is the order the full suite hits under load.
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ actual: null as typeof spawn | null }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  transport.actual = actual.spawn;
  return {
    ...actual,
    spawn: (command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess => {
      if (command !== "ssh" || !transport.actual) return actual.spawn(command, args, options);
      return transport.actual("sh", ["-c", "printf ok; printf early >&2; sleep 0.3 </dev/null >/dev/null & exit 0"], options);
    },
  };
});

import { runStreamProcess } from "./ssh.js";

it("returns the exit status when ssh exits before its stderr reaches EOF", async () => {
  const result = await runStreamProcess("ssh", [], { timeoutMs: 5_000 });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "ok" });
});
