import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { SshOffloadSync } from "./offload-ssh-sync.js";
import type { OffloadCommand } from "./offload.js";
import { isExecutorRefusal, type BackendCommand } from "./offload/broker.js";
import { listAllFilesAsTracked, noInitializedSubmodules, noUntrackedFiles } from "./test-support/tracked-files.js";
import { createFakeContext } from "./test-support/harness.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import type { BoatApiLike } from "./boat-client.js";
import { durationKey, normalizeSignature } from "./offload/duration-history.js";

// Consumer wiring for the explicit uv test extra: admission (gate), guest
// installation and venv discovery must plan from the SAME command.depSelection.
// Planner semantics are covered in offload/deps-install.test.ts.

const uvManifest = `[project]
name = "example"
version = "0.1.0"
[project.optional-dependencies]
test = ["pytest>=7"]
api = ["client>=1"]
`;
const uvLock = `version = 1
revision = 5
[[package]]
name = "example"
version = "0.1.0"
source = { editable = "." }
[package.optional-dependencies]
test = [{ name = "pytest" }]
api = [{ name = "client" }]
[package.metadata]
requires-dist = [
  { name = "pytest", specifier = ">=7", marker = "extra == 'test'" },
  { name = "client", specifier = ">=1", marker = "extra == 'api'" },
]
provides-extras = ["api", "test"]
[[package]]
name = "pytest"
version = "9.2.0"
source = { registry = "https://pypi.org/simple" }
[[package]]
name = "client"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
`;
const uvFiles = () => ({ "pyproject.toml": uvManifest, "uv.lock": uvLock });
const SELECTED = { uvExtra: "test", cwdRelative: "." } as const;

const tmpdirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boat-depsel-"));
  tmpdirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const executionWorkspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const repoId = "repo:https://github.com/example/public";

function pyCommand(over: Record<string, unknown> = {}): OffloadCommand {
  return { commandId: randomUUID(), companyId, runId, cardId: "", repoId, profileId: "python-public-1",
    tool: "python", runner: "pytest", argv: ["tests/"], cwdRelative: ".", env: {}, ...over } as OffloadCommand;
}

describe("installDependencies with an explicit selection", () => {
  function setup(root: string) {
    const calls: string[] = [];
    const ssh = {
      runStream: vi.fn(async (_s: unknown, cmd: string) => {
        calls.push(cmd);
        return { exitCode: cmd.includes("test -f") ? 1 : 0, timedOut: false, signal: null, stdout: "" };
      }),
    };
    const sync = new SshOffloadSync({ ssh: ssh as never, session: async () => ({} as never),
      sourceRoot: async () => root, artifactRoot: root, workRoot: "/tmp/boat-test" });
    const installs = () => calls.filter((c) => !c.includes("test -f"));
    return { sync, ssh, installs };
  }

  it("installs the selected extra and reuses it, with selected/default cache transitions", async () => {
    const root = tree(uvFiles());
    const { sync, installs } = setup(root);
    const selected = pyCommand({ depSelection: SELECTED });
    await sync.installDependencies("vm-1", selected, root, "/guest/work");
    expect(installs()).toHaveLength(1);
    expect(installs()[0]).toContain("--extra");
    expect(installs()[0]).toContain("test");
    await sync.installDependencies("vm-1", selected, root, "/guest/work");
    expect(installs()).toHaveLength(1); // same hash in the same mirror: cached
    // Default plan for the same lock has a different hash: must install again, without the extra.
    await sync.installDependencies("vm-1", pyCommand(), root, "/guest/work");
    expect(installs()).toHaveLength(2);
    expect(installs()[1]).not.toContain("--extra");
    // uv sync may remove the extra on the default transition: only the last hash is trusted.
    await sync.installDependencies("vm-1", selected, root, "/guest/work");
    expect(installs()).toHaveLength(3);
    expect(installs()[2]).toContain("--extra");
  });

  it("plans installation from frozen uploaded bytes when the live lock reverts during push", async () => {
    const root = tree(uvFiles());
    const artifactRoot = tree({});
    const installs: string[] = [];
    const ssh = { runStream: vi.fn(async (_s: unknown, cmd: string) => {
      installs.push(cmd);
      return { exitCode: 0, timedOut: false, signal: null, stdout: "" };
    }) };
    const sync = new SshOffloadSync({ ssh: ssh as never, session: async () => ({} as never),
      sourceRoot: async () => root, artifactRoot, trackedFiles: listAllFilesAsTracked });
    const selected = pyCommand({ depSelection: SELECTED });
    await sync.installDependencies("vm-1", selected, root, sync.directory(selected));
    expect(installs).toHaveLength(1);
    writeFileSync(path.join(root, "uv.lock"), uvLock + "# frozen state B\n");
    // Simulate an edit after capture, while the frozen snapshot is being uploaded.
    vi.spyOn(sync as unknown as { pushLocked: (...args: unknown[]) => Promise<void> }, "pushLocked")
      .mockImplementation(async () => { writeFileSync(path.join(root, "uv.lock"), uvLock); });
    await sync.push("vm-1", selected);
    expect(installs).toHaveLength(2); // B must install even though live A is cached.
    await sync.discard("vm-1", selected);
  });

  it("reinstalls when the manifest changes under a selection", async () => {
    const root = tree(uvFiles());
    const { sync, installs } = setup(root);
    const selected = pyCommand({ depSelection: SELECTED });
    await sync.installDependencies("vm-1", selected, root, "/guest/work");
    writeFileSync(path.join(root, "pyproject.toml"), uvManifest + "# changed\n");
    await sync.installDependencies("vm-1", selected, root, "/guest/work");
    expect(installs()).toHaveLength(2);
  });

  it("keeps the default plan when no selection is present", async () => {
    const root = tree(uvFiles());
    const { sync, installs } = setup(root);
    await sync.installDependencies("vm-1", pyCommand(), root, "/guest/work");
    expect(installs()[0]).not.toContain("--extra");
  });

  it.each([
    ["unknown key", { ...SELECTED, extra: "x" }, "."],
    ["wrong extra", { uvExtra: "dev", cwdRelative: "." }, "."],
    ["missing cwd", { uvExtra: "test" }, "."],
    ["non-string cwd", { uvExtra: "test", cwdRelative: 1 }, "."],
    ["null", null, "."],
    ["array", [], "."],
    ["cwd mismatch", SELECTED, "tests"],
    ["traversal", { uvExtra: "test", cwdRelative: "../x" }, "../x"],
  ])("refuses a %s selection without a default retry", async (_name, depSelection, cwdRelative) => {
    const root = tree({ ...uvFiles(), "tests/case.py": "" });
    const { sync, ssh } = setup(root);
    await expect(sync.installDependencies("vm-1", pyCommand({ depSelection, cwdRelative }), root, "/guest/work")).rejects.toThrow();
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it.each(["node", "cargo"])("refuses a selection on the %s tool", async (tool) => {
    const root = tree({ ...uvFiles(), "package-lock.json": "{}" });
    const { sync, ssh } = setup(root);
    await expect(sync.installDependencies("vm-1",
      pyCommand({ tool, runner: tool === "node" ? "npm" : "cargo", depSelection: SELECTED }), root, "/guest/work")).rejects.toThrow();
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("refuses a nested project selection instead of falling back to the default plan", async () => {
    const root = tree({ ...uvFiles(), "sub/pyproject.toml": uvManifest, "sub/tests/case.py": "" });
    const { sync, ssh } = setup(root);
    await expect(sync.installDependencies("vm-1",
      pyCommand({ cwdRelative: "sub", depSelection: { uvExtra: "test", cwdRelative: "sub" } }), root, "/guest/work")).rejects.toThrow(/lockfile/i);
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("installs the root selection for the actual nested command cwd", async () => {
    const root = tree({ ...uvFiles(), "tests/unit/case.py": "" });
    const { sync, installs } = setup(root);
    await sync.installDependencies("vm-1", pyCommand({ cwdRelative: "tests/unit",
      depSelection: { uvExtra: "test", cwdRelative: "tests/unit" } }), root, "/guest/work");
    expect(installs()).toHaveLength(1);
    expect(installs()[0]).toContain("--extra");
  });

  it("retains mixed Python-family refusal with an explicit selection", async () => {
    const root = tree({ ...uvFiles(), "requirements.txt": "pytest==9.2.0 --hash=sha256:abcdef\n" });
    const { sync, ssh } = setup(root);
    await expect(sync.installDependencies("vm-1", pyCommand({ depSelection: SELECTED }), root, "/guest/work")).rejects.toThrow();
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("refuses when the selected manifest does not declare the locked test extra", async () => {
    const root = tree({ "pyproject.toml": "[project]\nname = \"example\"\nversion = \"0.1.0\"\n", "uv.lock": uvLock });
    const { sync, ssh } = setup(root);
    await expect(sync.installDependencies("vm-1", pyCommand({ depSelection: SELECTED }), root, "/guest/work")).rejects.toThrow(/lockfile/i);
    expect(ssh.runStream).not.toHaveBeenCalled();
  });
});

describe("runtime admission and venv agreement", () => {
  function backend(source: string) {
    const seen: unknown[] = [];
    const sshStub = {
      masterAlive: () => false,
      runStream: vi.fn(async (_s: unknown, _c: string, opts: { stdin?: AsyncIterable<Uint8Array> }) => {
        if (!opts.stdin) return { exitCode: 0, timedOut: false, signal: null, stdout: "" };
        const chunks: Buffer[] = [];
        for await (const chunk of opts.stdin ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        return { exitCode: 0, timedOut: false, signal: null,
          stdout: JSON.stringify({ guestBootId: "boot-1", processGroupId: 1, cgroupPath: "/sys/fs/cgroup/x", journalGeneration: 1, heartbeatDeadline: 1, guestDeadline: 1 }) };
      }),
    };
    const workRoot = mkdtempSync(path.join(tmpdir(), "boat-depsel-work-"));
    tmpdirs.push(workRoot);
    const harness = createFakeContext();
    const boat = new FakeBoat({ now: Date.now });
    const runtime = new SshOffloadRuntime({
      state: harness.ctx.state, logger: harness.ctx.logger, ssh: sshStub as never, accountId: "test-only",
      boat: () => boat as unknown as BoatApiLike, session: async () => ({} as never),
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
      offloadAllowedRepos: [repoId], offloadProfiles: ["rust-public-1", "python-public-1"],
    };
    return { runtime, config, seen, state: harness.ctx.state };
  }
  const backendCommand = (over: Record<string, unknown> = {}): BackendCommand =>
    ({ ...pyCommand(), executionWorkspaceId, timeoutMs: 10_000, queueTimeoutMs: 0, ...over }) as BackendCommand;
  const refusalOf = async (runtime: SshOffloadRuntime, config: Record<string, unknown>, cmd: BackendCommand) => {
    const result = await runtime.resolve(cmd, config);
    return isExecutorRefusal(result) ? result.refusalReason : null;
  };

  it.each([false, true])("records remote completion under the matching selection signature (selected=%s)", async (selected) => {
    const source = tree(uvFiles());
    const { runtime, config, state } = backend(source);
    try {
      const cmd = backendCommand(selected ? { depSelection: SELECTED } : {});
      expect(await refusalOf(runtime, config, cmd)).toBeNull();
      // Invoke the real completion hook without allocating or running a guest.
      const pool = [...(runtime as unknown as { pools: Map<string, {
        executor: { recordDuration: (command: OffloadCommand, seconds: number) => Promise<void> };
      }> }).pools.values()][0]!;
      await pool.executor.recordDuration(cmd, 240);
      const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload" };
      const key = (selection: typeof SELECTED | undefined) => durationKey(repoId, "python-public-1",
        normalizeSignature("python", "pytest", ["tests/"], ".", selection));
      expect(await state.get({ ...scope, stateKey: key(selected ? SELECTED : undefined) })).toEqual([
        { seconds: 240, at: expect.any(Number) },
      ]);
      expect(await state.get({ ...scope, stateKey: key(selected ? undefined : SELECTED) })).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("admits a selected uv workspace and agrees with preflight, installation and venv", async () => {
    const source = tree(uvFiles());
    const { runtime, config, seen } = backend(source);
    try {
      const cmd = backendCommand({ depSelection: SELECTED, runner: "python" });
      expect(await runtime.preflight(cmd, config)).toBeNull();
      expect(await refusalOf(runtime, config, cmd)).toBeNull();
      const pool = [...(runtime as unknown as { pools: Map<string, never> }).pools.values()][0] as unknown as {
        sync: SshOffloadSync; guest: { prepare: (vm: string, c: unknown) => Promise<unknown> };
      };
      vi.spyOn(pool.sync as unknown as { pushLocked: (...args: unknown[]) => Promise<void> }, "pushLocked").mockResolvedValue(undefined);
      await pool.sync.push("vm-1", cmd);
      await pool.guest.prepare("vm-1", cmd);
      expect(String((seen[0] as Record<string, unknown>).executable)).toContain(".venv/bin/python");
      // Frozen success does not authorize a now-invalid explicit selection,
      // even for the same uploaded command. No further guest RPC may run.
      writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"example\"\nversion = \"0.1.0\"\n");
      await expect(pool.guest.prepare("vm-1", cmd)).rejects.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a selection when the manifest cannot support the extra, without defaulting", async () => {
    const source = tree({ "pyproject.toml": "[project]\nname = \"example\"\nversion = \"0.1.0\"\n", "uv.lock": uvLock });
    const { runtime, config } = backend(source);
    try {
      // The default plan admits this workspace; the explicit selection must not silently fall back to it.
      expect(await runtime.preflight(backendCommand(), config)).toBeNull();
      expect(await runtime.preflight(backendCommand({ depSelection: SELECTED }), config)).toMatch(/stays local/);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    ["unknown key", { ...SELECTED, extra: "x" }, "."],
    ["wrong extra", { uvExtra: "dev", cwdRelative: "." }, "."],
    ["null", null, "."],
    ["cwd mismatch", SELECTED, "tests"],
  ])("refuses a %s selection on a direct backend call", async (_name, depSelection, cwdRelative) => {
    const source = tree({ ...uvFiles(), "tests/case.py": "" });
    const { runtime, config } = backend(source);
    try {
      expect(await runtime.preflight(backendCommand(), config)).toBeNull();
      expect(await runtime.preflight(backendCommand({ depSelection, cwdRelative }), config)).toMatch(/stays local/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a selection under a nested project below the workspace root", async () => {
    const source = tree({ ...uvFiles(), "sub/pyproject.toml": uvManifest, "sub/uv.lock": uvLock, "sub/tests/case.py": "" });
    const { runtime, config } = backend(source);
    try {
      const cmd = backendCommand({ cwdRelative: "sub", depSelection: { uvExtra: "test", cwdRelative: "sub" } });
      expect(await runtime.preflight(cmd, config)).toMatch(/stays local/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a selection on a non-python tool or profile", async () => {
    const source = tree({ ...uvFiles(), "package-lock.json": "{}", "Cargo.toml": "[package]\nname=\"x\"\nversion=\"0.1.0\"\n" });
    const { runtime, config } = backend(source);
    try {
      const cargo = backendCommand({ profileId: "rust-public-1", tool: "cargo", runner: "cargo", argv: ["test"], depSelection: SELECTED });
      expect(await runtime.preflight(cargo, config)).toMatch(/stays local|not/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps the default plan and venv for a command without a selection", async () => {
    const source = tree(uvFiles());
    const { runtime, config } = backend(source);
    try {
      expect(await runtime.preflight(backendCommand(), config)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("scopes a python selection to the python ecosystem exactly like the default plan", async () => {
    // Python selection ignores Node lockfiles via the tool, exactly like the default plan.
    const source = tree({ ...uvFiles(), "package-lock.json": "{}", "yarn.lock": "x" });
    const { runtime, config } = backend(source);
    try {
      expect(await runtime.preflight(backendCommand(), config)).toBeNull();
      expect(await runtime.preflight(backendCommand({ depSelection: SELECTED }), config)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });
});
