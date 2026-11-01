import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { SshOffloadRuntime, hasCargoRegistryAuth } from "./offload-ssh-runtime.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { DEFAULT_API_BASE } from "./config.js";

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
    // The route has no runner field, so the broker defaults it to cargo and the
    // guest resolves that on its PATH. Stub cargo instead of overriding the executable.
    const bin = path.join(ssh.root, "stub-bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "cargo"), "#!/bin/sh\nprintf stock-worker\n", { mode: 0o755 });
    setManagerOverridesForTests({ ssh: ssh.manager, offloadTransport: { session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, path: `${bin}:/usr/bin:/bin` } } });
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => config } } as never);
    await plugin.definition.onEnvironmentRealizeWorkspace!(native());
    const cmd = command();
    const agentId = randomUUID();
    const actor = { actorType: "agent", actorId: agentId, agentId, runId };
    await currentManager().startLocalRun(companyId, runId, randomUUID(), agentId);
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
      expect((body.events as Array<{ dataBase64: string }>).map((e) => Buffer.from(e.dataBase64, "base64").toString()).join(""))
        .toBe("stock-worker");
    } else expect(["completed", "not_started"]).toContain(body.state);
    expect(boat.calls.some((call) => call.method === "create")).toBe(true);
  }, 20_000);
  it.each([{}, { offloadExecutorEnabled: true }, { ...{}, offloadGuestTransportEnabled: true }])("does not dispatch with incomplete gates %j", async (settings) => {
    expect(await runtime.resolve(command(), settings)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("re-validates a local-run binding's roots and on-disk origin on every resolve", async () => {
    await mkdir(path.join(source, ".git"));
    const origin = (url: string) => writeFile(path.join(source, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    await origin("https://github.com/example/public");
    runtime.forgetRun(companyId, runId);
    const localRunNative = native();
    (localRunNative.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>).localRun = true;
    runtime.remember(localRunNative);
    const rooted = { ...config, offloadLocalSourceRoots: [ssh.root] };
    expect(await runtime.resolve(command(), rooted)).not.toBe(null);
    await origin("https://github.com/example/private");
    expect(await runtime.resolve(command(), rooted)).toBe(null);
    await origin("https://github.com/example/public");
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: [] })).toBe(null);
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: ["/nonexistent-root"] })).toBe(null);
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
  it("keeps a command local when its directory would be absent from the guest mirror", async () => {
    await mkdir(path.join(source, "scratch"));
    await mkdir(path.join(source, "crates/foo/target"), { recursive: true });
    await writeFile(path.join(source, "crates/foo/target/out"), "build output");
    await mkdir(path.join(source, "secrets"));
    await writeFile(path.join(source, "secrets/.env"), "DO_NOT_UPLOAD=secret");
    for (const cwdRelative of ["scratch", "crates/foo/target", "missing", "secrets"]) {
      expect(await runtime.resolve({ ...command(), cwdRelative }, config)).toBe(null);
    }
    expect(boat.calls).toHaveLength(0);
    await writeFile(path.join(source, "crates/foo/lib.rs"), "fn main() {}");
    expect(await runtime.resolve({ ...command(), cwdRelative: "crates/foo" }, config)).not.toBe(null);
  });
  it("keeps a node command in a separately locked sub-project local", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await mkdir(path.join(source, "tools/app"), { recursive: true });
    await writeFile(path.join(source, "tools/app/package-lock.json"), "{}");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"], cwdRelative: "tools/app" } as BackendCommand;
    expect(await runtime.resolve(node, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toBe(null);
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

describe("templateSnapshot pool wiring", () => {
  // Pool identity before templateSnapshot existed. Existing pools persist their
  // VMs under this id, so an unset template must keep it byte-for-byte.
  function legacyPoolId(profileId = "rust-public-1") {
    return createHash("sha256").update(JSON.stringify([companyId, "env", "repo:https://github.com/example/public", profileId,
      DEFAULT_API_BASE, "small", config.offloadCgroupParent, config.offloadArtifactRoot])).digest("hex").slice(0, 24);
  }
  function withTemplate(name: string): PluginEnvironmentRealizeWorkspaceParams {
    const params = native();
    params.config = { ...params.config, templateSnapshot: name };
    return params;
  }

  it("keeps the legacy pool identity when no template is configured", async () => {
    const executor = (await runtime.resolve(command(), config))! as unknown as { poolId: string; config: { templateSnapshot: string | null } };
    expect(executor.poolId).toBe(legacyPoolId());
    expect(executor.config.templateSnapshot).toBe(null);
  });

  it("updates a cached executor when a later binding selects another template", async () => {
    const first = (await runtime.resolve(command(), config))! as unknown as { config: { templateSnapshot: string | null } };
    runtime.remember(withTemplate("tmpl-a"));
    const a = (await runtime.resolve(command(), config))! as unknown as { config: { templateSnapshot: string | null } };
    expect(a).toBe(first);
    expect(a.config.templateSnapshot).toBe("tmpl-a");
    runtime.remember(withTemplate("tmpl-b"));
    const b = (await runtime.resolve(command(), config))! as unknown as { config: { templateSnapshot: string | null } };
    expect(b).toBe(first);
    expect(b.config.templateSnapshot).toBe("tmpl-b");
    runtime.remember(native());
    expect(((await runtime.resolve(command(), config))! as unknown as { config: { templateSnapshot: string | null } }).config.templateSnapshot).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("forwards the configured template and keeps the pool identity, so recorded VMs stay owned", async () => {
    runtime.remember(withTemplate("tmpl-a"));
    const a = (await runtime.resolve(command(), config))! as unknown as { poolId: string; config: { templateSnapshot: string | null } };
    expect(a.config.templateSnapshot).toBe("tmpl-a");
    expect(a.poolId).toBe(legacyPoolId());
    expect(boat.calls).toHaveLength(0);
  });
  it("forwards the configured fork source to a cached executor and keeps the pool identity", async () => {
    const params = native();
    params.config = { ...params.config, templateSourceSandboxId: "bx_archived-fork" };
    runtime.remember(params);
    const a = (await runtime.resolve(command(), config))! as unknown as { poolId: string;
      config: { templateSnapshot: string | null; templateSourceSandboxId: string | null } };
    expect(a.config.templateSnapshot).toBe(null);
    expect(a.config.templateSourceSandboxId).toBe("bx_archived-fork");
    expect(a.poolId).toBe(legacyPoolId());
    expect(boat.calls).toHaveLength(0);
  });
  it("pushes a changed or cleared fork source to the reused executor", async () => {
    const view = async () => (await runtime.resolve(command(), config))! as unknown as
      { poolId: string; config: { templateSourceSandboxId: string | null } };
    const first = native();
    first.config = { ...first.config, templateSourceSandboxId: "bx_archived-a" };
    runtime.remember(first);
    const a = await view();
    expect(a.config.templateSourceSandboxId).toBe("bx_archived-a");
    // A later binding with a different source updates the cached executor
    // instead of leaving it forking from the stale sandbox.
    const second = native();
    second.config = { ...second.config, templateSourceSandboxId: "bx_archived-b" };
    runtime.remember(second);
    const b = await view();
    expect(b).toBe(a);
    expect(b.poolId).toBe(legacyPoolId());
    expect(b.config.templateSourceSandboxId).toBe("bx_archived-b");
    // Clearing the setting pushes null to the same executor.
    runtime.remember(native());
    expect((await view()).config.templateSourceSandboxId).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
});

describe("offline cargo registry guard", () => {
  const offline = (): BackendCommand => ({ ...command(), argv: ["test", "--offline"] });
  it("resolves an offline command with a clean source", async () => {
    expect(await runtime.resolve(offline(), config)).not.toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps an offline command local when the source pins a private registry", async () => {
    expect(await runtime.resolve(offline(), config)).not.toBe(null);
    await mkdir(path.join(source, ".cargo"), { recursive: true });
    await writeFile(path.join(source, ".cargo/config.toml"), '[source.crates-io]\nreplace-with = "private"\n');
    expect(await runtime.resolve(offline(), config)).toBe(null);
    // A non-offline command is unaffected: no guest fetch would run.
    expect(await runtime.resolve(command(), config)).not.toBe(null);
    expect(boat.calls).toHaveLength(0);
    await rm(path.join(source, ".cargo"), { recursive: true, force: true });
    expect(await runtime.resolve(offline(), config)).not.toBe(null);
  });
  it("keeps an offline command local when a nested checkout overrides the registry", async () => {
    await mkdir(path.join(source, "crates/foo/.cargo"), { recursive: true });
    await writeFile(path.join(source, "crates/foo/lib.rs"), "fn main() {}");
    await writeFile(path.join(source, "crates/foo/.cargo/config"), '[registries.private]\nindex = "https://example.com"\n');
    expect(await runtime.resolve({ ...offline(), cwdRelative: "crates/foo" }, config)).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
});

describe("hasCargoRegistryAuth", () => {
  const clean = '[source.crates-io]\nregistry = "https://github.com/rust-lang/crates.io-index"\n';
  async function configAt(relative: string, text: string) {
    const dir = path.join(source, relative, ".cargo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.toml"), text);
  }
  afterEach(async () => {
    await rm(path.join(source, "scan"), { recursive: true, force: true });
  });
  it("passes a missing or clean config", async () => {
    expect(await hasCargoRegistryAuth(path.join(source, "scan"), ".")).toBe(false);
    await configAt("scan", clean);
    expect(await hasCargoRegistryAuth(path.join(source, "scan"), ".")).toBe(false);
  });
  it.each([
    ["registry table", '[registries.private]\nindex = "sparse+https://example.com/"\n'],
    ["source replacement", '[source.crates-io]\nreplace-with = "vendored"\n'],
    ["credential provider", '[credential-provider.cargo]\nargs = ["login"]\n'],
    ["stored token", '[registry]\ntoken = "secret"\n'],
  ])("flags %s", async (_name, text) => {
    await configAt("scan", text);
    expect(await hasCargoRegistryAuth(path.join(source, "scan"), ".")).toBe(true);
  });
  it("discovers the command directory upward but not sideways", async () => {
    await configAt("scan", clean);
    await configAt("scan/crates/foo", clean);
    await mkdir(path.join(source, "scan/crates/bar"), { recursive: true });
    await configAt("scan/other", '[registries.private]\nindex = "sparse+https://example.com/"\n');
    const root = path.join(source, "scan");
    expect(await hasCargoRegistryAuth(root, "crates/foo")).toBe(false);
    expect(await hasCargoRegistryAuth(root, "crates/bar")).toBe(false);
    await configAt("scan", '[registries.private]\nindex = "sparse+https://example.com/"\n');
    expect(await hasCargoRegistryAuth(root, "crates/bar")).toBe(true);
  });
  it("fails closed on symlinked and over-limit configs", async () => {
    const dir = path.join(source, "scan");
    await mkdir(path.join(dir, ".cargo"), { recursive: true });
    await writeFile(path.join(dir, "real.toml"), clean);
    await symlink(path.join(dir, "real.toml"), path.join(dir, ".cargo/config.toml"));
    expect(await hasCargoRegistryAuth(dir, ".")).toBe(true);
    await rm(path.join(dir, ".cargo/config.toml"), { force: true });
    await writeFile(path.join(dir, ".cargo/config.toml"), `x = "${"y".repeat(70 * 1024)}"\n`);
    expect(await hasCargoRegistryAuth(dir, ".")).toBe(true);
  });
  it("fails closed on escaping and absolute command directories", async () => {
    const dir = path.join(source, "scan");
    await mkdir(dir, { recursive: true });
    for (const cwd of ["..", "../other", "..\\other", "/etc", "/"]) {
      expect(await hasCargoRegistryAuth(dir, cwd)).toBe(true);
    }
  });
  it("fails closed on a symlinked ancestor directory", async () => {
    const dir = path.join(source, "scan");
    await mkdir(path.join(dir, "real/sub"), { recursive: true });
    await symlink(path.join(dir, "real"), path.join(dir, "link"));
    // The link itself is never descended through, even when it resolves inside
    // the source root; the nested path below it cannot be attested either.
    expect(await hasCargoRegistryAuth(dir, "link")).toBe(true);
    expect(await hasCargoRegistryAuth(dir, "link/sub")).toBe(true);
    expect(await hasCargoRegistryAuth(dir, "real/sub")).toBe(false);
  });
  it("fails closed on a symlinked .cargo directory", async () => {
    const dir = path.join(source, "scan");
    const outside = path.join(source, "outside");
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await mkdir(outside, { recursive: true });
    // A clean config behind the link must not clear the scan: O_NOFOLLOW only
    // guards the final component, so the .cargo link itself is the escape.
    await writeFile(path.join(outside, "config.toml"), "[build]\njobs = 4\n");
    await symlink(outside, path.join(dir, ".cargo"));
    expect(await hasCargoRegistryAuth(dir, "sub")).toBe(true);
    expect(await hasCargoRegistryAuth(dir, ".")).toBe(true);
  });
  it("fails closed when nesting exhausts the walk budget", async () => {
    const dir = path.join(source, "scan");
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
    await mkdir(path.join(dir, deep), { recursive: true });
    expect(await hasCargoRegistryAuth(dir, deep)).toBe(true);
  });
});
