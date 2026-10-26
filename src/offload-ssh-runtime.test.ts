import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";

let ssh: LoopbackSsh;
let runtime: SshOffloadRuntime;
let boat: FakeBoat;
let source: string;
let cgroup: string;
let config: Record<string, unknown>;
const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  executionWorkspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
function command(): BackendCommand { return { companyId, runId, executionWorkspaceId, commandId: randomUUID(), cardId: "card",
  repoId: "repo:https://github.com/example/public", profileId: "rust-public-1", argv: ["test", "--locked"],
  cwdRelative: ".", env: {}, timeoutMs: 10_000, queueTimeoutMs: 0 }; }
function native(): PluginEnvironmentRealizeWorkspaceParams {
  return { driverKey: "boat", companyId, environmentId: "env", config: { apiKey: "test-only", maxOffloadVms: 1, offloadIdleStopSeconds: 1 },
    lease: { providerLeaseId: null }, workspace: { localPath: source, metadata: { workspaceRealizationRequest: {
      version: 1, companyId, environmentId: "env", heartbeatRunId: runId, executionWorkspaceId,
      source: { localPath: source, repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null },
    } } } };
}
beforeEach(async () => {
  ssh = new LoopbackSsh(); await ssh.start();
  source = path.join(ssh.root, "source"); await mkdir(source);
  await writeFile(path.join(source, "Cargo.lock"), "local-lock");
  await writeFile(path.join(source, ".env"), "DO_NOT_UPLOAD=secret");
  await writeFile(path.join(source, "Cargo.toml"), "public source");
  cgroup = process.env.PAPERCLIP_TEST_CGROUP_PARENT ?? `/sys/fs/cgroup${(await readFile("/proc/self/cgroup", "utf8")).trim().split("::")[1]}`;
  config = { offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
    offloadCgroupParent: cgroup, offloadArtifactRoot: path.join(ssh.root, "artifacts"),
    offloadAllowedRepos: ["repo:https://github.com/example/public"] };
  boat = new FakeBoat({ now: Date.now });
  const harness = createFakeContext();
  runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only",
    boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
    guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "set -e; printf 'from guest'; test ! -e .env; printf returned > Cargo.lock"] } });
  runtime.remember(native());
}, 15_000);
afterEach(async () => {
  await plugin.definition.onShutdown?.(); setManagerOverridesForTests({}); setBoatApiFactoryForTests(null);
  await runtime?.shutdown(); await ssh?.cleanup();
}, 20_000);

describe("stock concrete executor factory", () => {
  it("fences new pool resolution before awaiting shutdown of an existing pool", async () => {
    const executor = (await runtime.resolve(command(), config))!;
    let release!: () => void;
    const draining = new Promise<void>((resolve) => { release = resolve; });
    const shutdown = vi.spyOn(executor, "shutdown").mockImplementation(() => draining);
    const pending = runtime.shutdown();
    try {
      expect(shutdown).toHaveBeenCalledOnce();
      const another = native();
      another.environmentId = "another-env";
      (another.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>).environmentId = "another-env";
      runtime.remember(another);
      expect(await runtime.resolve(command(), config)).toBe(null);
      expect(boat.calls).toHaveLength(0);
    } finally {
      release();
      await pending;
      shutdown.mockRestore();
    }
  });
  it("fences a resolution already awaiting native source validation when shutdown starts", async () => {
    const resolving = runtime.resolve(command(), config);
    await runtime.shutdown();
    expect(await resolving).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("wires the stock worker from native params without injecting a lifecycle executor", async () => {
    const harness = createFakeContext({ workspaces: new Map([[executionWorkspaceId, {
      repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null, path: source, cwd: source,
    }]]) });
    setBoatApiFactoryForTests(() => boat as unknown as BoatApiLike);
    setManagerOverridesForTests({ ssh: ssh.manager, offloadTransport: { session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", args: () => ["-c", "printf stock-worker"], path: "/usr/bin:/bin" } } });
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => config } } as never);
    await plugin.definition.onEnvironmentRealizeWorkspace!(native());
    const cmd = command();
    const actor = { actorType: "agent", actorId: randomUUID(), runId };
    await plugin.definition.onApiRequest!({ routeKey: "offload_exec", companyId, actor, params: {}, query: {},
      body: { version: 1, commandId: cmd.commandId, executionWorkspaceId, argv: cmd.argv, cwdRelative: ".", env: {},
        queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: false } } as never);
    let body: Record<string, unknown> = {};
    await expect.poll(async () => {
      body = (await plugin.definition.onApiRequest!({ routeKey: "offload_read", companyId, actor,
        params: { commandId: cmd.commandId }, query: {} } as never)).body as Record<string, unknown>;
      return ["completed", "not_started", "unknown"].includes(String(body.state));
    }, { timeout: 15_000 }).toBe(true);
    if (process.env.PAPERCLIP_TEST_CGROUP_REQUIRED === "1") {
      expect(body).toMatchObject({ state: "completed", result: { exitCode: 0 } });
    } else expect(["completed", "not_started"]).toContain(body.state);
    expect(boat.calls.some((call) => call.method === "create")).toBe(true);
  }, 20_000);
  it.each([{}, { offloadExecutorEnabled: true }, { ...{}, offloadGuestTransportEnabled: true }])("does not dispatch with incomplete gates %j", async (settings) => {
    expect(await runtime.resolve(command(), settings)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it.each(["offloadExecutorEnabled", "offloadGuestTransportEnabled"])("requires boolean true for %s even with every other prerequisite", async (setting) => {
    for (const value of [false, undefined, "true", 1]) {
      expect(await runtime.resolve(command(), { ...config, [setting]: value })).toBe(null);
    }
    expect(boat.calls).toHaveLength(0);
  });
  it("requires explicit repository approval even after both flags are enabled", async () => {
    expect(await runtime.resolve(command(), { ...config, offloadAllowedRepos: [] })).toBe(null);
    expect(await runtime.resolve(command(), { ...config, offloadAllowedRepos: ["repo:another"] })).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("binds only native company/run/workspace metadata and rejects path-bearing cargo escapes", async () => {
    expect(await runtime.resolve({ ...command(), runId: "another-run" }, config)).toBe(null);
    expect(await runtime.resolve({ ...command(), argv: ["test", "--manifest-path=/etc/Cargo.toml"] }, config)).toBe(null);
    expect(await runtime.resolve({ ...command(), cwdRelative: "../escape" }, config)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("defensively refuses argv controls and lone surrogates in argv or cwd before resolving an executor or spending any VM starts", async () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      expect(await runtime.resolve({ ...command(), argv: ["test", `filter${String.fromCharCode(code)}suffix`] }, config)).toBe(null);
    }
    for (const lone of ["\ud800", "\udfff"]) {
      expect(await runtime.resolve({ ...command(), argv: ["test", `a${lone}b`] }, config)).toBe(null);
      expect(await runtime.resolve({ ...command(), cwdRelative: `crates/${lone}` }, config)).toBe(null);
    }
    expect(boat.calls).toHaveLength(0);
    expect(await runtime.resolve(command(), config)).not.toBe(null);
  });

  it("executes a native-bound command through the real SSH lifecycle, freezes source and stages returns without live writeback", async () => {
    const executor = await runtime.resolve(command(), config);
    expect(executor).not.toBe(null);
    expect(boat.calls).toHaveLength(0); // resolving a binding is side-effect free
    const cmd = command();
    await executor!.start(cmd);
    let view = await executor!.readOutput(companyId, runId, cmd.commandId);
    await expect.poll(async () => {
      view = await executor!.readOutput(companyId, runId, cmd.commandId);
      return ["completed", "not_started", "unknown"].includes(view.state);
    }, { timeout: 15_000 }).toBe(true);
    if (process.env.PAPERCLIP_TEST_CGROUP_REQUIRED === "1") {
      expect(view.state).toBe("completed");
      expect(view.events.map((e) => Buffer.from(e.dataBase64, "base64").toString()).join("")).toBe("from guest");
      expect(view.result).toMatchObject({ exitCode: 0, syncBack: { state: "staged", changedPaths: ["Cargo.lock"] } });
      expect(await readFile(path.join(source, "Cargo.lock"), "utf8")).toBe("local-lock");
      expect(await readFile(path.join(view.result!.syncBack.artifactId!, "files", "0001", "Cargo.lock"), "utf8")).toBe("returned");
      expect(boat.calls.find((call) => call.method === "create")?.args.monitoring).toBe(true);
    } else {
      expect(["completed", "not_started"]).toContain(view.state);
    }
  }, 20_000);
  it("admits a node command when the profile is enabled and a lockfile exists", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] };
    expect(await runtime.resolve(node, enabled)).not.toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local without an enabled profile, a lockfile, or a remote-candidate shape", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    expect(await runtime.resolve(node, config)).toBe(null);
    expect(await runtime.resolve(node, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"], offloadAllowedRepos: [] })).toBe(null);
    expect(await runtime.resolve({ ...node, argv: ["run", "dev"] }, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toBe(null);
    expect(await runtime.resolve({ ...node, runner: "bun" }, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toBe(null);
    await rm(path.join(source, "package-lock.json"), { force: true });
    expect(await runtime.resolve({ ...node } as BackendCommand, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local when a registry credential file is present", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await writeFile(path.join(source, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] };
    expect(await runtime.resolve(node, enabled)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local when a nested credential file is present", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await mkdir(path.join(source, "packages/app"), { recursive: true });
    await writeFile(path.join(source, "packages/app/.npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] };
    expect(await runtime.resolve(node, enabled)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps python local when uv auth config is present", async () => {
    await writeFile(path.join(source, "uv.lock"), "x");
    await writeFile(path.join(source, "uv.toml"), "[index]\n");
    const py = { ...command(), profileId: "python-public-1", tool: "python", runner: "python", argv: ["-m", "pytest"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "python-public-1"] };
    expect(await runtime.resolve(py, enabled)).toBe(null);
    await rm(path.join(source, "uv.toml"), { force: true });
    await writeFile(path.join(source, "pyproject.toml"), `[project]\nname = "app"\n[tool.uv]\nindex-url = "https://user:secret@example.com/simple"\n`);
    expect(await runtime.resolve(py, enabled)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps python local for inline code, absolute paths and escaping path flags", async () => {
    await writeFile(path.join(source, "requirements.txt"), "pytest==7.4.2 \\\n    --hash=sha256:abc123\n");
    const base = { ...command(), profileId: "python-public-1", tool: "python", runner: "python", argv: ["-m", "pytest"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "python-public-1"] };
    expect(await runtime.resolve(base, enabled)).not.toBe(null);
    expect(await runtime.resolve({ ...base, argv: ["-c", "print(1)"] }, enabled)).toBe(null);
    // pytest's own -c/--config after -m is a config file, not inline code.
    expect(await runtime.resolve({ ...base, argv: ["-m", "pytest", "-c", "pytest.ini", "tests/"] }, enabled)).not.toBe(null);
    expect(await runtime.resolve({ ...base, argv: ["-m", "pytest", "/etc/passwd"] }, enabled)).toBe(null);
    expect(await runtime.resolve({ ...base, argv: ["-m", "pytest", "--rootdir", ".."] }, enabled)).toBe(null);
    expect(await runtime.resolve({ ...base, runner: "pytest", argv: ["tests/", "--rootdir", "tests"] }, enabled)).not.toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
});
