import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID, scryptSync } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { SshOffloadRuntime, hasCargoRegistryAuth, scrubOffloadGuestBashrc, SUBMODULES_REASON, UNTRACKED_FILES_REASON } from "./offload-ssh-runtime.js";
import { shellQuote } from "./shell.js";
import type { SshManager } from "./ssh.js";
import { SshOffloadSync } from "./offload-ssh-sync.js";
import type { StateClientLike } from "./state.js";
import { listAllFilesAsTracked, noInitializedSubmodules, noUntrackedFiles } from "./test-support/tracked-files.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";
import { DEFAULT_API_BASE } from "./config.js";
import type { OffloadExecutor } from "./offload.js";
import { isExecutorRefusal, type ExecutorRefusal } from "./offload/broker.js";

/** resolve() returns a reasoned refusal instead of bare null; narrow where a test needs the executor. */
function mustResolve(value: OffloadExecutor | ExecutorRefusal): OffloadExecutor {
  if (isExecutorRefusal(value)) throw new Error(`unexpected offload refusal: ${value.refusalReason}`);
  return value;
}


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
  runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only", trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
    boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
    guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "set -e; printf 'from guest'; test ! -e .env; printf returned > Cargo.lock"] } });
  runtime.remember(native());
}, 15_000);
afterEach(async () => {
  await plugin.definition.onShutdown?.(); setManagerOverridesForTests({}); setBoatApiFactoryForTests(null);
  await runtime?.shutdown(); await ssh?.cleanup();
}, 20_000);

describe("project workspace alias", () => {
  it("withdraws an alias two execution workspaces claim with different sources", async () => {
    const projectWorkspaceId = randomUUID();
    const first = native();
    const firstRequest = first.workspace.metadata!.workspaceRealizationRequest as unknown as Record<string, Record<string, unknown>>;
    firstRequest.source!.projectWorkspaceId = projectWorkspaceId;
    runtime.remember(first);
    expect(runtime.has(companyId, runId, projectWorkspaceId)).toBe(true);
    const otherWorkspaceId = randomUUID();
    const otherSource = path.join(ssh.root, "other-checkout");
    const second = native();
    second.workspace.localPath = otherSource;
    const secondRequest = second.workspace.metadata!.workspaceRealizationRequest as unknown as Record<string, Record<string, unknown> | string>;
    secondRequest.executionWorkspaceId = otherWorkspaceId;
    (secondRequest.source as Record<string, unknown>).localPath = otherSource;
    (secondRequest.source as Record<string, unknown>).projectWorkspaceId = projectWorkspaceId;
    runtime.remember(second);
    // The shared id resolves to neither checkout; each workspace keeps its own.
    expect(runtime.has(companyId, runId, projectWorkspaceId)).toBe(false);
    expect(runtime.has(companyId, runId, executionWorkspaceId)).toBe(true);
    expect(runtime.has(companyId, runId, otherWorkspaceId)).toBe(true);
    // Re-realizing the first workspace does not resurrect the ambiguous alias.
    runtime.remember(first);
    expect(runtime.has(companyId, runId, projectWorkspaceId)).toBe(false);
  });

  it("a whole-run realization without the alias supersedes the local-run alias binding", async () => {
    const localRunId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const mutate = (params: PluginEnvironmentRealizeWorkspaceParams, fn: (request: Record<string, unknown>) => void) => {
      const request = params.workspace.metadata!.workspaceRealizationRequest as unknown as Record<string, unknown>;
      request.heartbeatRunId = localRunId;
      fn(request);
      return params;
    };
    runtime.remember(mutate(native(), (request) => {
      request.localRun = true;
      (request.source as Record<string, unknown>).projectWorkspaceId = projectWorkspaceId;
    }));
    expect(runtime.has(companyId, localRunId, projectWorkspaceId)).toBe(true);
    // The whole-run payload for the same run and workspace omits the alias.
    runtime.remember(mutate(native(), () => undefined));
    // With no local source roots configured, a local-run binding under the
    // alias could not resolve; the whole-run binding the alias now answers
    // with can.
    expect(runtime.has(companyId, localRunId, projectWorkspaceId)).toBe(true);
    mustResolve(await runtime.resolve({ ...command(), runId: localRunId, executionWorkspaceId: projectWorkspaceId }, config));
  });
});

describe("project workspace alias across runs", () => {
  it("keys the alias per run: two runs sharing one project workspace never resolve each other's source", async () => {
    const projectWorkspaceId = randomUUID();
    const otherRunId = randomUUID();
    const emptySource = path.join(ssh.root, "empty-checkout");
    await mkdir(emptySource);
    // A valid cargo checkout except for one secret-bearing tracked name, so
    // the gate refuses it with exactly one source-dependent reason.
    await writeFile(path.join(emptySource, "Cargo.lock"), "local-lock");
    await writeFile(path.join(emptySource, "Cargo.toml"), "public source");
    await writeFile(path.join(emptySource, "deploy.key"), "not a real key");
    const realize = (forRunId: string, localPath: string, workspaceId: string) => {
      const params = native();
      params.workspace.localPath = localPath;
      const request = params.workspace.metadata!.workspaceRealizationRequest as unknown as Record<string, unknown>;
      request.heartbeatRunId = forRunId;
      request.executionWorkspaceId = workspaceId;
      const src = request.source as Record<string, unknown>;
      src.localPath = localPath;
      src.projectWorkspaceId = projectWorkspaceId;
      return params;
    };
    // Bound within the same tick, as two runs starting together would be.
    runtime.remember(realize(runId, source, executionWorkspaceId));
    runtime.remember(realize(otherRunId, emptySource, randomUUID()));
    expect(runtime.has(companyId, runId, projectWorkspaceId)).toBe(true);
    expect(runtime.has(companyId, otherRunId, projectWorkspaceId)).toBe(true);
    // The first run resolves through the shared alias to its own checkout.
    mustResolve(await runtime.resolve({ ...command(), executionWorkspaceId: projectWorkspaceId }, config));
    // The second run gets its own checkout, so the read-only gates refuse it
    // for its own secret-bearing file — never the first run's clean source,
    // and never a missing binding.
    const refused = await runtime.resolve({ ...command(), runId: otherRunId, executionWorkspaceId: projectWorkspaceId }, config);
    expect(isExecutorRefusal(refused)).toBe(true);
    if (isExecutorRefusal(refused)) {
      expect(refused.refusalReason).toBe("tracked secret-bearing file keeps the command local");
    }
  });
});

describe("stock concrete executor factory", () => {
  it("fences new pool resolution before awaiting shutdown of an existing pool", async () => {
    const executor = mustResolve(await runtime.resolve(command(), config));
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
      expect(await runtime.resolve(command(), config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
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
    expect(await resolving).toEqual({ refusalReason: "offload runtime is shutting down" });
    expect(boat.calls).toHaveLength(0);
  });
  it("fences a resolution awaiting the credential digest when shutdown starts", async () => {
    const resolving = runtime.resolve(command(), config);
    // Park resolve on the async KDF before starting shutdown: the digest
    // promise is memoized on the binding before it is awaited, so observing it
    // means resolve is inside the digest await, past the earlier closing check.
    const view = runtime as unknown as { bindings: Map<string, { credentialDigest?: Promise<string> }>, pools: Map<string, unknown> };
    let settled = false;
    void resolving.then(() => { settled = true; }, () => { settled = true; });
    while (!settled && ![...view.bindings.values()].some((binding) => binding.credentialDigest !== undefined)) {
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    }
    expect([...view.bindings.values()].some((binding) => binding.credentialDigest !== undefined)).toBe(true);
    await runtime.shutdown();
    expect(await resolving).toEqual({ refusalReason: "offload runtime is shutting down" });
    expect(view.pools.size).toBe(0);
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
    setManagerOverridesForTests({ ssh: ssh.manager, offloadTransport: { session: async () => ssh.session, trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
      guestOptions: { stateRoot: ssh.root, path: `${bin}:/usr/bin:/bin` } } });
    const cmd = command();
    const agentId = randomUUID();
    // Fixture only: the operator-issued exact-run grant and the fake host's verified run identity.
    const now = Date.now();
    const granted = { ...config, offloadAdmission: { version: 1, companyId, agentId, runId, executionWorkspaceId,
      commandId: cmd.commandId, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString() } };
    await plugin.definition.setup({ ...harness.ctx, config: { get: async () => granted } } as never);
    await plugin.definition.onEnvironmentRealizeWorkspace!(native());
    const actor = { actorType: "agent", actorId: agentId, agentId, runId, authenticatedRunId: runId };
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
    expect(await runtime.resolve(command(), settings)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("re-validates a local-run binding's roots and on-disk origin on every resolve", async () => {
    await mkdir(path.join(source, ".git"));
    const origin = (url: string) => writeFile(path.join(source, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    await origin("https://github.com/example/public");
    runtime.forgetRun(companyId, runId);
    const localRunNative = native();
    const localRequest = localRunNative.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>;
    localRequest.localRun = true;
    localRequest.executionWorkspaceSettings = null;
    runtime.remember(localRunNative);
    const rooted = { ...config, offloadLocalSourceRoots: [ssh.root] };
    mustResolve(await runtime.resolve(command(), rooted));
    await origin("https://github.com/example/private");
    expect(await runtime.resolve(command(), rooted)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await origin("https://github.com/example/public");
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: ["/nonexistent-root"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("refuses a queued local-run upload when the origin flips or the roots drop after resolve", async () => {
    await mkdir(path.join(source, ".git"));
    const origin = (url: string) => writeFile(path.join(source, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    await origin("https://github.com/example/public");
    runtime.forgetRun(companyId, runId);
    const localRunNative = native();
    const localRequest = localRunNative.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>;
    localRequest.localRun = true;
    localRequest.executionWorkspaceSettings = null;
    runtime.remember(localRunNative);
    const rooted = { ...config, offloadLocalSourceRoots: [ssh.root] };
    const executor = mustResolve(await runtime.resolve(command(), rooted));
    expect(executor).not.toBe(null);
    const pools = (runtime as unknown as { pools: Map<string, { sync: { push(sandboxId: string, cmd: BackendCommand): Promise<void> } }> }).pools;
    const sync = [...pools.values()][0]!.sync;
    // The command sat queued after resolve; the checkout's origin flips before
    // its snapshot. The push must refuse before anything is uploaded.
    await origin("https://github.com/example/private");
    await expect(sync.push("sandbox-queued", command())).rejects.toThrow(/no longer passes roots\/origin validation/);
    // Restoring the origin but dropping the configured roots (observed by the
    // next resolve) refuses the still-queued push the same way.
    await origin("https://github.com/example/public");
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await expect(sync.push("sandbox-queued", command())).rejects.toThrow(/no longer passes roots\/origin validation/);
    expect(boat.calls).toHaveLength(0);
    // End to end: with roots restored, a post-resolve origin flip makes the
    // admitted command end not_started (fallback-safe) with no guest output.
    expect(await runtime.resolve(command(), rooted)).toBe(executor);
    await origin("https://github.com/example/private");
    const cmd = command();
    await executor.start(cmd);
    let view = await executor.readOutput(companyId, runId, cmd.commandId);
    await expect.poll(async () => {
      view = await executor.readOutput(companyId, runId, cmd.commandId);
      return view.state;
    }, { timeout: 15_000 }).toBe("not_started");
    expect(view.events).toHaveLength(0);
  }, 20_000);
  it("scopes queued-upload roots per company: another company's config neither cancels nor resurrects a queued push", async () => {
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/example/public\n`);
    runtime.forgetRun(companyId, runId);
    const localRunNative = native();
    const localRequest = localRunNative.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>;
    localRequest.localRun = true;
    localRequest.executionWorkspaceSettings = null;
    runtime.remember(localRunNative);
    const rooted = { ...config, offloadLocalSourceRoots: [ssh.root] };
    const executor = mustResolve(await runtime.resolve(command(), rooted));
    expect(executor).not.toBe(null);
    const pools = (runtime as unknown as { pools: Map<string, { sync: { push(sandboxId: string, cmd: BackendCommand): Promise<void> } }> }).pools;
    const sync = [...pools.values()][0]!.sync;
    const otherCompanyId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    // Config is per-company: company B resolving with empty roots (it has no
    // binding, so resolve returns null) must not cancel company A's queued push.
    expect(await runtime.resolve({ ...command(), companyId: otherCompanyId }, { ...config, offloadLocalSourceRoots: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await expect(sync.push("sandbox-queued", command())).resolves.toBeUndefined();
    // Symmetrically, once A drops its own roots, B resolving with roots that
    // cover the source must not resurrect A's queued push.
    expect(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...command(), companyId: otherCompanyId }, rooted)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await expect(sync.push("sandbox-queued", command())).rejects.toThrow(/no longer passes roots\/origin validation/);
    expect(boat.calls).toHaveLength(0);
  }, 20_000);
  describe("task network policy gate", () => {
    const withPolicy = (settings: unknown, localRun = false) => {
      runtime.forgetRun(companyId, runId);
      const params = native();
      const request = params.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>;
      request.localRun = localRun;
      request.executionWorkspaceSettings = settings;
      runtime.remember(params);
    };
    it.each([
      ["FQDN grant", { networkEgress: { allowFqdns: ["private-policy.example.test"] } }],
      ["empty grant", { networkEgress: {} }],
      ["malformed settings container", "synthetic-policy-payload-do-not-emit"],
    ])("refuses a binding with a snapshotted %s before any pool or VM effect", async (_name, settings) => {
      withPolicy(settings, true);
      const refused = await runtime.resolve(command(), config);
      expect(isExecutorRefusal(refused)).toBe(true);
      if (isExecutorRefusal(refused)) {
        expect(refused.refusalReason).toContain(_name === "malformed settings container" ? "unavailable" : "network egress");
        expect(refused.refusalReason).not.toContain("private-policy.example.test");
        expect(refused.refusalReason).not.toContain("synthetic-policy-payload-do-not-emit");
      }
      // The dry-run preflight verdict is predictive of the real submit.
      expect(await runtime.preflight(command(), config)).toContain("running local");
      expect(boat.calls).toHaveLength(0);
    });
    it.each([
      ["null settings", null],
      ["omitted policy", {}],
      ["null policy", { networkEgress: null }],
    ])("admits a binding whose task policy is %s (unrestricted compatibility)", async (_name, settings) => {
      await mkdir(path.join(source, ".git"));
      await writeFile(path.join(source, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/example/public\n`);
      withPolicy(settings, true);
      mustResolve(await runtime.resolve(command(), { ...config, offloadLocalSourceRoots: [ssh.root] }));
    });
    it("fails a local-run binding without a policy snapshot closed", async () => {
      runtime.forgetRun(companyId, runId);
      const params = native();
      (params.workspace.metadata!.workspaceRealizationRequest as Record<string, unknown>).localRun = true;
      runtime.remember(params);
      expect(await runtime.resolve(command(), config))
        .toEqual({ refusalReason: "task network policy is unavailable; running local" });
      expect(boat.calls).toHaveLength(0);
    });
    it("keeps a snapshot-free whole-run binding on the lease-checked path", async () => {
      // native() carries no settings field and localRun is false: the lease
      // admission already checked this run's policy.
      mustResolve(await runtime.resolve(command(), config));
    });
  });
  it.each(["offloadExecutorEnabled", "offloadGuestTransportEnabled"])("requires boolean true for %s even with every other prerequisite", async (setting) => {
    for (const value of [false, undefined, "true", 1]) {
      expect(await runtime.resolve(command(), { ...config, [setting]: value })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    }
    expect(boat.calls).toHaveLength(0);
  });
  it("requires explicit repository approval even after both flags are enabled", async () => {
    expect(await runtime.resolve(command(), { ...config, offloadAllowedRepos: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve(command(), { ...config, offloadAllowedRepos: ["repo:another"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  // Real-git admission (no trackedFiles seam): the default listing gates resolve().
  function realGitRuntime(): SshOffloadRuntime {
    const harness = createFakeContext();
    const rt = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only",
      boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "printf done"] } });
    rt.remember(native());
    return rt;
  }
  function gitIn(dir: string, ...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  }
  it("keeps a non-git source local: resolve returns null and no VM is spent", async () => {
    const rt = realGitRuntime();
    try {
      expect(await rt.resolve(command(), config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  // The fixture's .env (and any .dev.vars) are ignored, not merely untracked:
  // an untracked, non-ignored file keeps the command local on its own.
  async function gitInitIgnoringSecrets(): Promise<void> {
    gitIn(source, "init", "-q", ".");
    await writeFile(path.join(source, ".gitignore"), ".env\n.dev.vars\ntarget/\n");
    gitIn(source, "add", ".gitignore");
  }
  it("keeps a workspace with a tracked fake AWS key local", async () => {
    await gitInitIgnoringSecrets();
    await writeFile(path.join(source, "config.rs"), 'const K: &str = "AKIAIOSFODNN7EXAMPLE";\n');
    gitIn(source, "add", "Cargo.toml", "Cargo.lock", "config.rs");
    const rt = realGitRuntime();
    try {
      const refused = await rt.resolve(command(), config);
      expect(refused).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
      expect(refused).not.toEqual({ refusalReason: UNTRACKED_FILES_REASON });
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("admits a clean git work tree with only tracked files syncable", async () => {
    await gitInitIgnoringSecrets();
    await writeFile(path.join(source, ".dev.vars"), "CF_API_TOKEN=untracked\n");
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    const rt = realGitRuntime();
    try {
      mustResolve(await rt.resolve(command(), config));
    } finally { await rt.shutdown(); }
  });
  it("keeps cargo local when a tracked .pem is not a verifiable public certificate", async () => {
    await gitInitIgnoringSecrets();
    await mkdir(path.join(source, "tests/fixtures"), { recursive: true });
    await writeFile(path.join(source, "tests/fixtures/ca.pem"), "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    gitIn(source, "add", "Cargo.toml", "Cargo.lock", "tests/fixtures/ca.pem");
    const rt = realGitRuntime();
    try {
      expect(await rt.resolve(command(), config)).toEqual(expect.objectContaining({ refusalReason: expect.stringContaining("not a verified public certificate") }));
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("admits cargo when the only tracked .pem is a public CA certificate fixture", async () => {
    await gitInitIgnoringSecrets();
    await mkdir(path.join(source, "scripts/ci/fixtures"), { recursive: true });
    await writeFile(path.join(source, "scripts/ci/fixtures/isrg-x1.pem"),
      readFileSync(new URL("./test-support/isrg-root-x1.pem", import.meta.url), "utf8"));
    gitIn(source, "add", "Cargo.toml", "Cargo.lock", "scripts/ci/fixtures/isrg-x1.pem");
    const rt = realGitRuntime();
    try {
      mustResolve(await rt.resolve(command(), config));
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("keeps a tracked-only tree a remote candidate on dry-run and real submit", async () => {
    await gitInitIgnoringSecrets();
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    const rt = realGitRuntime();
    try {
      expect(await rt.preflight(command(), config)).toBeNull();
      mustResolve(await rt.resolve(command(), config));
    } finally { await rt.shutdown(); }
  });
  it("keeps cargo local with the named reason when an untracked, non-ignored file exists (dry-run and real submit agree)", async () => {
    await gitInitIgnoringSecrets();
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    // A new module the tracked tree references before its first commit.
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src/new_module.rs"), "pub fn added() {}\n");
    const rt = realGitRuntime();
    try {
      expect(await rt.preflight(command(), config)).toBe(UNTRACKED_FILES_REASON);
      expect(await rt.resolve(command(), config)).toEqual({ refusalReason: UNTRACKED_FILES_REASON });
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("keeps an ignored-only untracked file (target/) a remote candidate", async () => {
    await gitInitIgnoringSecrets();
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    await mkdir(path.join(source, "target/debug"), { recursive: true });
    await writeFile(path.join(source, "target/debug/build.log"), "ignored\n");
    const rt = realGitRuntime();
    try {
      expect(await rt.preflight(command(), config)).toBeNull();
      mustResolve(await rt.resolve(command(), config));
    } finally { await rt.shutdown(); }
  });
  // The mirror is the parent index only: submodule contents never sync.
  function addGitlink(): void {
    gitIn(source, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,vendor/dep");
  }
  it("keeps cargo local with the named reason when an initialized submodule exists (dry-run and real submit agree)", async () => {
    await gitInitIgnoringSecrets();
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    addGitlink();
    await mkdir(path.join(source, "vendor/dep/src"), { recursive: true });
    await writeFile(path.join(source, "vendor/dep/src/lib.rs"), "pub fn dep() {}\n");
    gitIn(path.join(source, "vendor/dep"), "init", "-q", ".");
    const rt = realGitRuntime();
    try {
      expect(await rt.preflight(command(), config)).toBe(SUBMODULES_REASON);
      expect(await rt.resolve(command(), config)).toEqual({ refusalReason: SUBMODULES_REASON });
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("keeps an uninitialized submodule (empty gitlink directory) a remote candidate", async () => {
    await gitInitIgnoringSecrets();
    gitIn(source, "add", "Cargo.toml", "Cargo.lock");
    addGitlink();
    await mkdir(path.join(source, "vendor/dep"), { recursive: true });
    const rt = realGitRuntime();
    try {
      expect(await rt.preflight(command(), config)).toBeNull();
      mustResolve(await rt.resolve(command(), config));
    } finally { await rt.shutdown(); }
  });
  it("fails closed to local when the submodule check cannot answer", async () => {
    const harness = createFakeContext();
    const rt = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only",
      trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: async () => { throw new Error("git exploded"); },
      boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "printf done"] } });
    rt.remember(native());
    try {
      expect(await rt.preflight(command(), config)).toBe(SUBMODULES_REASON);
      expect(await rt.resolve(command(), config)).toEqual({ refusalReason: SUBMODULES_REASON });
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("fails closed to local when the untracked-file check cannot answer", async () => {
    const harness = createFakeContext();
    const rt = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only",
      trackedFiles: listAllFilesAsTracked, untrackedFiles: async () => { throw new Error("git exploded"); },
      boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "printf done"] } });
    rt.remember(native());
    try {
      expect(await rt.preflight(command(), config)).toBe(UNTRACKED_FILES_REASON);
      expect(await rt.resolve(command(), config)).toEqual({ refusalReason: UNTRACKED_FILES_REASON });
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("keeps cargo local when a tracked .pem carries a private key alongside a public certificate", async () => {
    gitIn(source, "init", "-q", ".");
    await mkdir(path.join(source, "tests/fixtures"), { recursive: true });
    const bundle = readFileSync(new URL("./test-support/isrg-root-x1.pem", import.meta.url), "utf8")
      + "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBBQ==\n-----END PRIVATE KEY-----\n";
    await writeFile(path.join(source, "tests/fixtures/bundle.pem"), bundle);
    gitIn(source, "add", "Cargo.toml", "Cargo.lock", "tests/fixtures/bundle.pem");
    const rt = realGitRuntime();
    try {
      expect(await rt.resolve(command(), config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
      expect(boat.calls).toHaveLength(0);
    } finally { await rt.shutdown(); }
  });
  it("binds only native company/run/workspace metadata and rejects path-bearing cargo escapes", async () => {
    expect(await runtime.resolve({ ...command(), runId: "another-run" }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...command(), argv: ["test", "--manifest-path=/etc/Cargo.toml"] }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...command(), cwdRelative: "../escape" }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("defensively refuses argv controls and lone surrogates in argv or cwd before resolving an executor or spending any VM starts", async () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      expect(await runtime.resolve({ ...command(), argv: ["test", `filter${String.fromCharCode(code)}suffix`] }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    }
    for (const lone of ["\ud800", "\udfff"]) {
      expect(await runtime.resolve({ ...command(), argv: ["test", `a${lone}b`] }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
      expect(await runtime.resolve({ ...command(), cwdRelative: `crates/${lone}` }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    }
    expect(boat.calls).toHaveLength(0);
    mustResolve(await runtime.resolve(command(), config));
  });

  it("executes a native-bound command through the real SSH lifecycle, freezes source and stages returns without live writeback", async () => {
    const executor = mustResolve(await runtime.resolve(command(), config));
    expect(boat.calls).toHaveLength(0); // resolving a binding is side-effect free
    const cmd = command();
    await executor.start(cmd);
    let view = await executor.readOutput(companyId, runId, cmd.commandId);
    await expect.poll(async () => {
      view = await executor.readOutput(companyId, runId, cmd.commandId);
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
    mustResolve(await runtime.resolve(node, enabled));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local without an enabled profile, a lockfile, or a remote-candidate shape", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    expect(await runtime.resolve(node, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve(node, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"], offloadAllowedRepos: [] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...node, argv: ["run", "dev"] }, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...node, runner: "bun" }, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await rm(path.join(source, "package-lock.json"), { force: true });
    expect(await runtime.resolve({ ...node } as BackendCommand, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local when a registry credential file is present", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await writeFile(path.join(source, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] };
    expect(await runtime.resolve(node, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps node local when a nested credential file is present", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await mkdir(path.join(source, "packages/app"), { recursive: true });
    await writeFile(path.join(source, "packages/app/.npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] };
    expect(await runtime.resolve(node, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps a command local when its directory would be absent from the guest mirror", async () => {
    await mkdir(path.join(source, "scratch"));
    await mkdir(path.join(source, "crates/foo/target"), { recursive: true });
    await writeFile(path.join(source, "crates/foo/target/out"), "build output");
    await mkdir(path.join(source, "secrets"));
    await writeFile(path.join(source, "secrets/.env"), "DO_NOT_UPLOAD=secret");
    for (const cwdRelative of ["scratch", "crates/foo/target", "missing", "secrets"]) {
      expect(await runtime.resolve({ ...command(), cwdRelative }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    }
    expect(boat.calls).toHaveLength(0);
    await writeFile(path.join(source, "crates/foo/lib.rs"), "fn main() {}");
    mustResolve(await runtime.resolve({ ...command(), cwdRelative: "crates/foo" }, config));
    mustResolve(await runtime.resolve({ ...command(), cwdRelative: "./crates/foo" }, config));
    mustResolve(await runtime.resolve({ ...command(), cwdRelative: "crates/foo/." }, config));
  });
  it("keeps a node command in a separately locked sub-project local", async () => {
    await writeFile(path.join(source, "package-lock.json"), "{}");
    await mkdir(path.join(source, "tools/app"), { recursive: true });
    await writeFile(path.join(source, "tools/app/package-lock.json"), "{}");
    const node = { ...command(), profileId: "node-public-1", tool: "node", runner: "npm", argv: ["run", "test"], cwdRelative: "tools/app" } as BackendCommand;
    expect(await runtime.resolve(node, { ...config, offloadProfiles: ["rust-public-1", "node-public-1"] })).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps python local when uv auth config is present", async () => {
    await writeFile(path.join(source, "uv.lock"), "x");
    await writeFile(path.join(source, "uv.toml"), "[index]\n");
    const py = { ...command(), profileId: "python-public-1", tool: "python", runner: "python", argv: ["-m", "pytest"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "python-public-1"] };
    expect(await runtime.resolve(py, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    await rm(path.join(source, "uv.toml"), { force: true });
    await writeFile(path.join(source, "pyproject.toml"), `[project]\nname = "app"\n[tool.uv]\nindex-url = "https://user:secret@example.com/simple"\n`);
    expect(await runtime.resolve(py, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps python local for inline code, absolute paths and escaping path flags", async () => {
    await writeFile(path.join(source, "requirements.txt"), "pytest==7.4.2 \\\n    --hash=sha256:abc123\n");
    const base = { ...command(), profileId: "python-public-1", tool: "python", runner: "python", argv: ["-m", "pytest"] } as BackendCommand;
    const enabled = { ...config, offloadProfiles: ["rust-public-1", "python-public-1"] };
    mustResolve(await runtime.resolve(base, enabled));
    expect(await runtime.resolve({ ...base, argv: ["-c", "print(1)"] }, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    // pytest's own -c/--config after -m is a config file, not inline code.
    mustResolve(await runtime.resolve({ ...base, argv: ["-m", "pytest", "-c", "pytest.ini", "tests/"] }, enabled));
    expect(await runtime.resolve({ ...base, argv: ["-m", "pytest", "/etc/passwd"] }, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    expect(await runtime.resolve({ ...base, argv: ["-m", "pytest", "--rootdir", ".."] }, enabled)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    mustResolve(await runtime.resolve({ ...base, runner: "pytest", argv: ["tests/", "--rootdir", "tests"] }, enabled));
    expect(boat.calls).toHaveLength(0);
  });
});

describe("templateSnapshot pool wiring", () => {
  // Pool identity: template selection is not part of it, but the credential
  // digest is, so template changes keep this id byte-for-byte for an unchanged
  // API key (native() uses "test-only").
  function legacyPoolId(profileId = "rust-public-1") {
    const baseIdentity = JSON.stringify([companyId, "env", "repo:https://github.com/example/public", profileId,
      DEFAULT_API_BASE, "small", config.offloadCgroupParent, config.offloadArtifactRoot]);
    const credentialDigest = scryptSync("test-only", `boat-offload-pool\u0000${DEFAULT_API_BASE}`, 32).toString("hex");
    return createHash("sha256").update(JSON.stringify([baseIdentity, credentialDigest])).digest("hex").slice(0, 24);
  }
  function withTemplate(name: string): PluginEnvironmentRealizeWorkspaceParams {
    const params = native();
    params.config = { ...params.config, templateSnapshot: name };
    return params;
  }

  it("keeps a stable pool identity when no template is configured", async () => {
    const executor = mustResolve(await runtime.resolve(command(), config)) as unknown as { poolId: string; config: { templateSnapshot: string | null } };
    expect(executor.poolId).toBe(legacyPoolId());
    expect(executor.config.templateSnapshot).toBe(null);
  });

  it("updates a cached executor when a later binding selects another template", async () => {
    const first = mustResolve(await runtime.resolve(command(), config)) as unknown as { config: { templateSnapshot: string | null } };
    runtime.remember(withTemplate("tmpl-a"));
    const a = mustResolve(await runtime.resolve(command(), config)) as unknown as { config: { templateSnapshot: string | null } };
    expect(a).toBe(first);
    expect(a.config.templateSnapshot).toBe("tmpl-a");
    runtime.remember(withTemplate("tmpl-b"));
    const b = mustResolve(await runtime.resolve(command(), config)) as unknown as { config: { templateSnapshot: string | null } };
    expect(b).toBe(first);
    expect(b.config.templateSnapshot).toBe("tmpl-b");
    runtime.remember(native());
    expect((mustResolve(await runtime.resolve(command(), config)) as unknown as { config: { templateSnapshot: string | null } }).config.templateSnapshot).toBe(null);
    expect(boat.calls).toHaveLength(0);
  });
  it("forwards the configured template and keeps the pool identity, so recorded VMs stay owned", async () => {
    runtime.remember(withTemplate("tmpl-a"));
    const a = mustResolve(await runtime.resolve(command(), config)) as unknown as { poolId: string; config: { templateSnapshot: string | null } };
    expect(a.config.templateSnapshot).toBe("tmpl-a");
    expect(a.poolId).toBe(legacyPoolId());
    expect(boat.calls).toHaveLength(0);
  });
  it("forwards the configured fork source to a cached executor and keeps the pool identity", async () => {
    const params = native();
    params.config = { ...params.config, templateSourceSandboxId: "bx_archived-fork" };
    runtime.remember(params);
    const a = mustResolve(await runtime.resolve(command(), config)) as unknown as { poolId: string;
      config: { templateSnapshot: string | null; templateSourceSandboxId: string | null } };
    expect(a.config.templateSnapshot).toBe(null);
    expect(a.config.templateSourceSandboxId).toBe("bx_archived-fork");
    expect(a.poolId).toBe(legacyPoolId());
    expect(boat.calls).toHaveLength(0);
  });
  it("pushes a changed or cleared fork source to the reused executor", async () => {
    const view = async () => mustResolve(await runtime.resolve(command(), config)) as unknown as
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
    mustResolve(await runtime.resolve(offline(), config));
    expect(boat.calls).toHaveLength(0);
  });
  it("keeps an offline command local when the source pins a private registry", async () => {
    mustResolve(await runtime.resolve(offline(), config));
    await mkdir(path.join(source, ".cargo"), { recursive: true });
    await writeFile(path.join(source, ".cargo/config.toml"), '[source.crates-io]\nreplace-with = "private"\n');
    expect(await runtime.resolve(offline(), config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
    // A non-offline command is unaffected: no guest fetch would run.
    mustResolve(await runtime.resolve(command(), config));
    expect(boat.calls).toHaveLength(0);
    await rm(path.join(source, ".cargo"), { recursive: true, force: true });
    mustResolve(await runtime.resolve(offline(), config));
  });
  it("keeps an offline command local when a nested checkout overrides the registry", async () => {
    await mkdir(path.join(source, "crates/foo/.cargo"), { recursive: true });
    await writeFile(path.join(source, "crates/foo/lib.rs"), "fn main() {}");
    await writeFile(path.join(source, "crates/foo/.cargo/config"), '[registries.private]\nindex = "https://example.com"\n');
    expect(await runtime.resolve({ ...offline(), cwdRelative: "crates/foo" }, config)).toEqual(expect.objectContaining({ refusalReason: expect.any(String) }));
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

describe("pool credential identity and guest token scrub", () => {
  function nativeWithKey(apiKey: string): PluginEnvironmentRealizeWorkspaceParams {
    const params = native();
    params.config = { apiKey, maxOffloadVms: 1, offloadIdleStopSeconds: 1 };
    return params;
  }

  it("binds a new pool to a rotated API key and sweeps the superseded pool", async () => {
    const seenKeys: Array<string | null> = [];
    const harness = createFakeContext();
    const rotating = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only", trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
      boat: (cfg) => { seenKeys.push(cfg.apiKey); return boat as unknown as BoatApiLike; }, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "true"] } });
    try {
      rotating.remember(nativeWithKey("key-a"));
      const first = mustResolve(await rotating.resolve(command(), config));
      expect(first).not.toBeNull();
      const sweepFirst = vi.spyOn(first, "sweep");

      rotating.remember(nativeWithKey("key-b"));
      const second = mustResolve(await rotating.resolve(command(), config));
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      // The factory built a new client from the rotated key, and the pool
      // bound to the old credential was swept under it before retirement.
      expect(seenKeys).toEqual(["key-a", "key-b"]);
      expect(sweepFirst).toHaveBeenCalled();

      // Same key again resolves to the same cached pool.
      expect(await rotating.resolve(command(), config)).toBe(second);
      expect(seenKeys).toEqual(["key-a", "key-b"]);
    } finally {
      await rotating.shutdown();
    }
  });

  it("removes boat's seeded ASCII_TOKEN line from ~/.bashrc over loopback ssh", async () => {
    const bashrc = path.join(ssh.root, ".bashrc");
    await writeFile(bashrc, "# user rc\nexport ASCII_TOKEN=seeded-secret\nkeep=1\n");
    // The loopback sshd logs in as the host user, so point HOME at the
    // fixture root for this call instead of touching the real ~/.bashrc; the
    // scrub itself is the exact command the session factory runs.
    const manager = ssh.manager;
    const homeBound = { run: (session: never, remoteCommand: string, options: never) =>
      manager.run(session, `HOME=${shellQuote(ssh.root)} ${remoteCommand}`, options) } as unknown as SshManager;
    await scrubOffloadGuestBashrc(homeBound, ssh.session);
    expect(await readFile(bashrc, "utf8")).toBe("# user rc\nkeep=1\n");
  });

  it("never fails the session when the scrub command fails", async () => {
    const failing = { run: async () => { throw new Error("ssh down"); } } as unknown as SshManager;
    await expect(scrubOffloadGuestBashrc(failing, ssh.session)).resolves.toBeUndefined();
  });
});
describe("journal partial-write recovery", () => {
  // A state wrapper that drops the journal record write while letting the
  // index write land: the crash between the store's index and record writes.
  function faultingState(backing: StateClientLike, shouldFail: () => boolean): StateClientLike {
    return {
      get: (input) => backing.get(input),
      set: (input, value) => {
        if (shouldFail() && (input.namespace ?? "").startsWith("boat-executor-") && input.stateKey !== "index") {
          throw new Error("injected store failure");
        }
        return backing.set(input, value);
      },
      delete: (input) => backing.delete(input),
    };
  }
  function testRuntime(state: StateClientLike) {
    const harness = createFakeContext();
    const rt = new SshOffloadRuntime({ state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only", trackedFiles: listAllFilesAsTracked, untrackedFiles: noUntrackedFiles, submodules: noInitializedSubmodules,
      boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "set -e; printf 'from guest'; test ! -e .env; printf returned > Cargo.lock"] } });
    rt.remember(native());
    return rt;
  }

  it("fails a torn admission without spending a VM, then heals through the pool sweep and runs a new command", async () => {
    let failJournalRecords = false;
    const harness = createFakeContext();
    const rt = testRuntime(faultingState(harness.ctx.state, () => failJournalRecords));
    try {
      const executor = mustResolve(await rt.resolve(command(), config));
      expect(executor).not.toBe(null);
      expect(boat.calls).toHaveLength(0);

      failJournalRecords = true;
      await expect(executor.execute(command())).rejects.toThrow("injected store failure");
      expect(boat.callsOf("create")).toHaveLength(0);
      failJournalRecords = false;

      // The loaded-pool sweep prunes the dangling index and reaches sync
      // retention instead of throwing the pool unverified.
      const collectGarbage = vi.spyOn(SshOffloadSync.prototype, "collectGarbage");
      try {
        await expect(rt.sweep()).resolves.toBeUndefined();
        expect(collectGarbage).toHaveBeenCalled();
      } finally {
        collectGarbage.mockRestore();
      }

      // The pool accepts new work after recovery. The claim runs before the
      // guest preflight, so one (fake) VM is spent even where the guest then
      // refuses: without a delegated cgroup v2 the preflight fails before
      // spawn, the pre-start failure settles fallback-safe unavailable, and
      // only hosts with PAPERCLIP_TEST_CGROUP_REQUIRED=1 run the guest.
      const result = await executor.execute(command());
      expect(boat.callsOf("create")).toHaveLength(1);
      const detail = result.status === "completed" ? `exitCode=${result.exitCode}` : `${result.code}: ${result.reason}`;
      if (process.env.PAPERCLIP_TEST_CGROUP_REQUIRED === "1") {
        expect(result.status, `post-recovery execute settled ${result.status} (${detail})`).toBe("completed");
      } else {
        expect(["completed", "not_started", "unknown", "unavailable"],
          `post-recovery execute settled ${result.status} (${detail})`).toContain(result.status);
        if (result.status === "unavailable") {
          expect(result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
        }
      }
    } finally {
      await rt.shutdown();
    }
  }, 30_000);

  it("retires a ghost pool whose journal index tore without failing the sweep", async () => {
    const harness = createFakeContext();
    const rt = testRuntime(harness.ctx.state);
    try {
      const ghostPoolId = "ghost-pool-b15";
      const ghostRoot = path.join(ssh.root, "ghost-artifacts");
      await mkdir(ghostRoot, { recursive: true });
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" },
        { [ghostPoolId]: { artifactRoot: ghostRoot, seenAt: Date.now() } });
      // Index entry with no record: a crash between the store's index and
      // record writes in a pool that is no longer loaded.
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: companyId, namespace: `boat-executor-${ghostPoolId}`, stateKey: "index" },
        [`command/${companyId}/${runId}/ghost-cmd`]);

      await expect(rt.sweep([companyId])).resolves.toBeUndefined();
      expect(await harness.ctx.state.get(
        { scopeKind: "company", scopeId: companyId, namespace: `boat-executor-${ghostPoolId}`, stateKey: "index" }))
        .toEqual([]);
      expect(boat.calls).toHaveLength(0);
    } finally {
      await rt.shutdown();
    }
  }, 30_000);
});
