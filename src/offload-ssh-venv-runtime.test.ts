import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { listAllFilesAsTracked } from "./test-support/tracked-files.js";
import { createFakeContext } from "./test-support/harness.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";

const tmpdirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const executionWorkspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

function backend(source: string): { runtime: SshOffloadRuntime; boat: FakeBoat; config: Record<string, unknown>; seen: unknown[]; workRoot: string } {
  const seen: unknown[] = [];
  const sshStub = {
    masterAlive: () => false,
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
  const workRoot = mkdtempSync(path.join(tmpdir(), "boat-venv-work-"));
  tmpdirs.push(workRoot);
  const harness = createFakeContext();
  const boat = new FakeBoat({ now: Date.now });
  const runtime = new SshOffloadRuntime({
    state: harness.ctx.state, logger: harness.ctx.logger,
    ssh: sshStub as never, accountId: "test-only",
    boat: () => boat as unknown as BoatApiLike,
    session: async () => ({} as never),
    guestOptions: { stateRoot: workRoot }, trackedFiles: listAllFilesAsTracked,
  });
  runtime.remember({
    driverKey: "boat", companyId, environmentId: "env",
    config: { apiKey: "test-only", maxOffloadVms: 1, offloadIdleStopSeconds: 1 },
    lease: { providerLeaseId: null },
    workspace: { localPath: source, metadata: { workspaceRealizationRequest: {
      version: 1, companyId, environmentId: "env", heartbeatRunId: runId, executionWorkspaceId,
      source: { localPath: source, repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null },
    } } },
  } as never);
  const config: Record<string, unknown> = {
    offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
    offloadCgroupParent: "/sys/fs/cgroup/", offloadArtifactRoot: path.join(workRoot, "artifacts"),
    offloadAllowedRepos: ["repo:https://github.com/example/public"],
    offloadProfiles: ["rust-public-1", "python-public-1"],
  };
  return { runtime, boat, config, seen, workRoot };
}

function pyCommand(): BackendCommand {
  return { companyId, runId, executionWorkspaceId, commandId: randomUUID(), cardId: "card",
    repoId: "repo:https://github.com/example/public", profileId: "python-public-1",
    tool: "python", runner: "python", argv: ["-m", "pytest", "tests/"],
    cwdRelative: ".", env: {}, timeoutMs: 10_000, queueTimeoutMs: 0 };
}

describe("runtime uv venv wiring", () => {
  it("prepares a uv.lock workspace from the checkout venv", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "boat-venv-src-"));
    tmpdirs.push(source);
    await writeFile(path.join(source, "uv.lock"), "x");
    const { runtime, config, seen } = backend(source);
    try {
      const cmd = pyCommand();
      const executor = await runtime.resolve(cmd, config);
      expect(executor).not.toBe(null);
      const pool = [...(runtime as unknown as { pools: Map<string, never> }).pools.values()][0] as unknown as { guest: { prepare: (vm: string, c: unknown) => Promise<unknown> } };
      await pool.guest.prepare("vm-1", { ...cmd, commandId: cmd.commandId, companyId, runId, cardId: "", repoId: cmd.repoId, profileId: cmd.profileId, tool: "python", runner: "python", argv: cmd.argv, cwdRelative: ".", env: {} });
      const input = seen[0] as Record<string, unknown>;
      const env = input.env as Record<string, string>;
      expect(String(input.executable)).toContain(".venv/bin/python");
      expect(env.VIRTUAL_ENV).toMatch(/\.venv$/);
      expect(String(input.path)).toMatch(/\.venv\/bin:/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps a pinned-requirements workspace on the system runner", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "boat-venv-src-"));
    tmpdirs.push(source);
    await writeFile(path.join(source, "requirements.txt"), "pytest==7.4.2 \\\n    --hash=sha256:abc123\n");
    const { runtime, config, seen } = backend(source);
    try {
      const cmd = pyCommand();
      const executor = await runtime.resolve(cmd, config);
      expect(executor).not.toBe(null);
      const pool = [...(runtime as unknown as { pools: Map<string, never> }).pools.values()][0] as unknown as { guest: { prepare: (vm: string, c: unknown) => Promise<unknown> } };
      await pool.guest.prepare("vm-1", { ...cmd, commandId: cmd.commandId, companyId, runId, cardId: "", repoId: cmd.repoId, profileId: cmd.profileId, tool: "python", runner: "python", argv: cmd.argv, cwdRelative: ".", env: {} });
      const input = seen[0] as Record<string, unknown>;
      expect(input.executable).toBe("python");
      expect(Object.keys(input.env as Record<string, string>).sort()).toEqual(["CARGO_HOME", "HOME", "PYTHONUSERBASE"]);
      expect(String(input.path)).not.toContain(".venv/bin");
    } finally {
      await runtime.shutdown();
    }
  });
});
