import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { ARTIFACT_RETENTION_MS, type SshOffloadSync } from "./offload-ssh-sync.js";
import { SshGuestStore } from "./offload-ssh-guest-store.js";
import type { SshOffloadGuest } from "./offload-ssh.js";
import type { OffloadCommand, OffloadExecutor } from "./offload.js";
import { isExecutorRefusal, type ExecutorRefusal } from "./offload/broker.js";
import { listAllFilesAsTracked, noInitializedSubmodules, noUntrackedFiles } from "./test-support/tracked-files.js";
import { createFakeContext } from "./test-support/harness.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";

function mustResolve(value: OffloadExecutor | ExecutorRefusal): OffloadExecutor {
  if (isExecutorRefusal(value)) throw new Error(`unexpected offload refusal: ${value.refusalReason}`);
  return value;
}

const tmpdirs: string[] = [];
beforeEach(() => {
  // Real snapshot and install planning, mocked guest filesystem/transport only.
  vi.spyOn(SshGuestStore.prototype, "verifyMirror").mockResolvedValue({ marker: null, suspect: null, mismatched: [] });
  vi.spyOn(SshGuestStore.prototype, "push").mockResolvedValue({ files: 0, bytes: 0, skipped: 0 });
  vi.spyOn(SshGuestStore.prototype, "writeMarker").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const executionWorkspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

function backend(source: string, onInstall?: () => Promise<void>) {
  const seen: Array<Record<string, unknown>> = [];
  const sshStub = {
    masterAlive: () => false,
    runStream: vi.fn(async (_session: unknown, _cmd: string, opts: { stdin?: AsyncIterable<Uint8Array> }) => {
      if (!opts.stdin) {
        await onInstall?.();
        return { exitCode: 0, timedOut: false, signal: null, stdout: "" };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of opts.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
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
    guestOptions: { stateRoot: workRoot }, trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
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
  return { runtime, config, seen, ssh: sshStub };
}

function pyCommand(): OffloadCommand & BackendCommand {
  return { companyId, runId, executionWorkspaceId, commandId: randomUUID(), cardId: "card",
    repoId: "repo:https://github.com/example/public", profileId: "python-public-1",
    tool: "python", runner: "python", argv: ["-m", "pytest", "tests/"],
    cwdRelative: ".", env: {}, timeoutMs: 10_000, queueTimeoutMs: 0 };
}

function pool(runtime: SshOffloadRuntime) {
  return [...(runtime as unknown as { pools: Map<string, { sync: SshOffloadSync; guest: SshOffloadGuest }> }).pools.values()][0];
}

async function source(lockfile = "uv.lock", contents = "x") {
  const dir = await mkdtemp(path.join(tmpdir(), "boat-venv-src-"));
  tmpdirs.push(dir);
  await writeFile(path.join(dir, lockfile), contents);
  return dir;
}

function expectVenv(input: Record<string, unknown>, guestDir: string) {
  expect(input.executable).toBe(`${guestDir}/.venv/bin/python`);
  expect((input.env as Record<string, string>).VIRTUAL_ENV).toBe(`${guestDir}/.venv`);
  expect(String(input.path)).toMatch(/\.venv\/bin:/);
}

describe("runtime uv venv wiring", () => {
  it.each(["remove", "change"])("uses the successful frozen uv identity after live lock %s", async (mutation) => {
    const root = await source();
    const { runtime, config, seen } = backend(root);
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", cmd);
      if (mutation === "remove") await rm(path.join(root, "uv.lock"));
      else await writeFile(path.join(root, "uv.lock"), "new live plan");
      await guest.prepare("vm-1", cmd);
      expectVenv(seen[0], sync.directory(cmd));
    } finally { await runtime.shutdown(); }
  });

  it("plans the uploaded bytes even when live lock removal happens during install", async () => {
    const root = await source();
    const { runtime, config, seen } = backend(root, () => rm(path.join(root, "uv.lock")));
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", cmd);
      await guest.prepare("vm-1", cmd);
      expectVenv(seen[0], sync.directory(cmd));
    } finally { await runtime.shutdown(); }
  });

  it("does not replan live bytes changed between upload and install planning", async () => {
    const root = await source();
    vi.mocked(SshGuestStore.prototype.push).mockImplementationOnce(async () => {
      await rm(path.join(root, "uv.lock"));
      await writeFile(path.join(root, "requirements.txt"), "pytest==7.4.2 --hash=sha256:abc123\n");
      return { files: 0, bytes: 0, skipped: 0 };
    });
    const { runtime, config, seen, ssh } = backend(root);
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", cmd);
      expect(ssh.runStream.mock.calls[0][1]).toContain("uv");
      await guest.prepare("vm-1", cmd);
      expectVenv(seen[0], sync.directory(cmd));
    } finally { await runtime.shutdown(); }
  });

  it("carries the frozen identity through a cache hit and successful push retry", async () => {
    const root = await source();
    // A stable guest marker lets the second upload retain the active install.
    let marker: Awaited<ReturnType<SshGuestStore["verifyMirror"]>>["marker"] = null;
    vi.mocked(SshGuestStore.prototype.verifyMirror).mockImplementation(async () => ({ marker, suspect: null, mismatched: [] }));
    vi.mocked(SshGuestStore.prototype.writeMarker).mockImplementation(async (_dir, value) => { marker = value; });
    const { runtime, config, seen, ssh } = backend(root);
    try {
      const first = pyCommand();
      mustResolve(await runtime.resolve(first, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", first);
      const second = pyCommand();
      await sync.push("vm-1", second);
      expect(ssh.runStream).toHaveBeenCalledTimes(1);
      await sync.push("vm-1", second);
      expect(ssh.runStream).toHaveBeenCalledTimes(1);
      await rm(path.join(root, "uv.lock"));
      await guest.prepare("vm-1", second);
      expectVenv(seen[0], sync.directory(second));
    } finally { await runtime.shutdown(); }
  });

  it("keeps pinned requirements on the system runner even if live source gains uv.lock", async () => {
    const root = await source("requirements.txt", "pytest==7.4.2 --hash=sha256:abc123\n");
    const { runtime, config, seen } = backend(root);
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", cmd);
      await rm(path.join(root, "requirements.txt"));
      await writeFile(path.join(root, "uv.lock"), "x");
      await guest.prepare("vm-1", cmd);
      expect(seen[0].executable).toBe("python");
      expect(Object.keys(seen[0].env as Record<string, string>).sort()).toEqual(["CARGO_HOME", "HOME", "PYTHONUSERBASE"]);
      expect(String(seen[0].path)).not.toContain(".venv/bin");
    } finally { await runtime.shutdown(); }
  });

  it("refuses missing, changed-command and cross-sandbox identities before another RPC", async () => {
    const root = await source();
    const { runtime, config, ssh } = backend(root);
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await expect(guest.prepare("vm-1", cmd)).rejects.toThrow(/frozen Python/);
      expect(ssh.runStream).not.toHaveBeenCalled();
      await sync.push("vm-1", cmd);
      const count = ssh.runStream.mock.calls.length;
      await expect(guest.prepare("vm-2", cmd)).rejects.toThrow(/frozen Python/);
      await expect(guest.prepare("vm-1", pyCommand())).rejects.toThrow(/frozen Python/);
      await expect(guest.prepare("vm-1", { ...cmd, runner: "pytest" })).rejects.toThrow(/frozen Python/);
      expect(ssh.runStream).toHaveBeenCalledTimes(count);
    } finally { await runtime.shutdown(); }
  });

  it.each(["stage", "discard", "gc", "push failure", "install failure"])("cleans frozen identity on %s", async (cleanup) => {
    const root = await source();
    const { runtime, config, ssh } = backend(root);
    try {
      const cmd = pyCommand();
      mustResolve(await runtime.resolve(cmd, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", cmd);
      if (cleanup === "stage") await sync.stage("vm-1", cmd, { state: "staged", changedPaths: [], conflictPaths: [], artifactDir: null });
      if (cleanup === "discard") await sync.discard("vm-1", cmd);
      if (cleanup === "gc") {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + ARTIFACT_RETENTION_MS + 1);
        await sync.collectGarbage();
      }
      if (cleanup === "push failure") {
        vi.mocked(SshGuestStore.prototype.push).mockRejectedValueOnce(new Error("mock transfer failed"));
        await expect(sync.push("vm-1", cmd)).rejects.toThrow(/transfer failed/);
      }
      if (cleanup === "install failure") {
        ssh.runStream.mockRejectedValueOnce(new Error("mock install failed"));
        await expect(sync.push("vm-1", cmd)).rejects.toThrow(/install failed/);
      }
      const count = ssh.runStream.mock.calls.length;
      await expect(guest.prepare("vm-1", cmd)).rejects.toThrow(/frozen Python/);
      expect(ssh.runStream).toHaveBeenCalledTimes(count);
    } finally { await runtime.shutdown(); }
  });

  it("refuses a superseded environment instead of leaking another command's identity", async () => {
    const root = await source();
    const { runtime, config, seen } = backend(root);
    try {
      const first = pyCommand();
      mustResolve(await runtime.resolve(first, config));
      const { sync, guest } = pool(runtime);
      await sync.push("vm-1", first);
      await writeFile(path.join(root, "uv.lock"), "B");
      const second = pyCommand();
      await sync.push("vm-1", second);
      await expect(guest.prepare("vm-1", first)).rejects.toThrow(/frozen Python/);
      await guest.prepare("vm-1", second);
      expectVenv(seen[0], sync.directory(second));
    } finally { await runtime.shutdown(); }
  });
});
