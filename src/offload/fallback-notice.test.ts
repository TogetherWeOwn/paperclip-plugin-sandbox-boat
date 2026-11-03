// Regression coverage for the silent local fallback: a command classified as
// a remote candidate that ends up running locally must always say so, with
// the specific pre-start refusal reason, on the shim's stderr — and the
// dry-run answer must not promise remote past a read-only executor gate.
import { describe, expect, it, vi } from "vitest";
import { SshOffloadRuntime } from "../offload-ssh-runtime.js";
import type { SshManager } from "../ssh.js";
import type { StateClientLike } from "../state.js";
import { createFakeContext } from "../test-support/harness.js";
import { BoatVmManager } from "../vm-manager.js";
import {
  OffloadBroker,
  type BackendCommand,
  type OffloadJournalStore,
  type OffloadOutputSink,
} from "./broker.js";
import type { HttpResult } from "./client.js";
import { ExecutorBackend } from "./executor-backend.js";
import type { OffloadReadResponse, OffloadSubmitRequest } from "./protocol.js";
import { handleExec, type OffloadRouteHost, type RouteActor } from "./routes.js";
import { shimMain, type ShimDeps } from "./shim-main.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const AS_CARGO = "/opt/boat-offload/bin/cargo";
const REAL_CARGO = "/usr/local/cargo/bin/cargo";

// --------------------------------------------------------------- shim level

function shimSetup() {
  const clock = { t: 1_000_000 };
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const deps: ShimDeps = {
    env: {
      PATH: "/opt/boat-offload/bin:/usr/local/cargo/bin:/usr/bin",
      PAPERCLIP_WORKSPACE_ID: WS,
      PAPERCLIP_WORKSPACE_CWD: "/work/repo",
      BOAT_OFFLOAD: "1",
    },
    http: {
      post: vi.fn(async (): Promise<HttpResult> => ({ ok: true, status: 500, json: {} })),
      get: vi.fn(async (): Promise<HttpResult> => ({ ok: true, status: 500, json: {} })),
    },
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    stdout: (b: Uint8Array) => out.push(Buffer.from(b)),
    stderr: (b: Uint8Array) => err.push(Buffer.from(b)),
    onSignal: () => {},
    randomId: () => CMD,
    findExecutable: (dir: string, name: string) => (dir !== "/opt/boat-offload/bin" && name === "cargo" ? REAL_CARGO : null),
    cwd: () => "/work/repo",
    canonicalDir: (p: string) => p,
    readToolchains: () => ["stable", "1.99.1"],
    spawn: vi.fn(async () => ({ code: 7 as number | null, signal: null as string | null })),
  };
  return { deps, stderrText: () => Buffer.concat(err).toString() };
}

function dryRunRemote(t: ReturnType<typeof shimSetup>) {
  return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible subcommand check", profileId: "rust-public-1" } } as HttpResult;
}

describe("shim fallback notices", () => {
  it("(a) dry-run remote, executor refuses pre-start: local run keeps its exit code and the notice carries the journaled reason", async () => {
    const t = shimSetup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: { dryRun?: boolean }) => {
      if (body.dryRun === true) return dryRunRemote(t);
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    (t.deps.http.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: {
        version: 1, commandId: CMD, state: "not_started", remoteStarted: false, fallbackSafe: true,
        fallbackReason: "repo is not on the offload allowlist",
        events: [], nextCursor: 0, result: null, terminalError: null,
      },
    }));
    const exit = await shimMain(AS_CARGO, ["check", "--locked"], t.deps);
    expect(exit).toBe(7); // the local cargo exit, unchanged
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderrText()).toContain("offload: running local (repo is not on the offload allowlist)\n");
  });

  it("(a) fallback-safe submit envelope: local run and the notice carries the envelope detail", async () => {
    const t = shimSetup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: { dryRun?: boolean }) => {
      if (body.dryRun === true) return dryRunRemote(t);
      return {
        ok: true,
        status: 503,
        json: {
          type: "https://boat.offload/errors/v1", title: "Offload unavailable", status: 503,
          code: "OFFLOAD_UNAVAILABLE", detail: "profile rust-public-1 is not enabled for offload",
          retryable: true, next_action: "x", commandId: CMD, remoteStarted: false, fallbackSafe: true,
        },
      };
    });
    const exit = await shimMain(AS_CARGO, ["check", "--locked"], t.deps);
    expect(exit).toBe(7);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderrText()).toContain("offload: running local (profile rust-public-1 is not enabled for offload)\n");
  });

  it("(b) internal dry-run throws: local run with a notice, never silent", async () => {
    const t = shimSetup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: false, error: "connection refused" }));
    const exit = await shimMain(AS_CARGO, ["check", "--locked"], t.deps);
    expect(exit).toBe(7);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderrText()).toContain("offload: running local (dry-run failed: offload dry-run failed: connection refused)\n");
  });

  it("internal dry-run answers local after a remote-candidate prefilter: local run with the server's reason", async () => {
    const t = shimSetup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true, status: 200,
      json: { version: 1, commandId: CMD, mode: "local", reason: "no offload binding for this run and workspace", profileId: "rust-public-1" },
    }));
    const exit = await shimMain(AS_CARGO, ["check", "--locked"], t.deps);
    expect(exit).toBe(7);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderrText()).toContain("offload: running local (no offload binding for this run and workspace)\n");
  });

  it("a rejecting local spawn after a local dry-run verdict surfaces once, never re-runs as a dry-run failure", async () => {
    const t = shimSetup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true, status: 200,
      json: { version: 1, commandId: CMD, mode: "local", reason: "pinned toolchain is not supported", profileId: "rust-public-1" },
    }));
    (t.deps.spawn as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error("spawn EINVAL"); });
    await expect(shimMain(AS_CARGO, ["check", "--locked"], t.deps)).rejects.toThrow("spawn EINVAL");
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderrText()).toContain("offload: running local (pinned toolchain is not supported)\n");
    expect(t.stderrText()).not.toContain("dry-run failed");
  });
});

// ------------------------------------------------------------- broker level

class MapStore implements OffloadJournalStore {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe("broker fallback reason", () => {
  it("journals the failToStart reason and serves it on the read view", async () => {
    let sink!: OffloadOutputSink;
    const broker = new OffloadBroker({
      store: new MapStore(),
      backend: {
        start: (_cmd: BackendCommand, s: OffloadOutputSink) => {
          sink = s;
          return { done: Promise.resolve(), cancel: async () => {} };
        },
      },
      now: () => 1_000_000,
    });
    const request: OffloadSubmitRequest = {
      version: 1, commandId: CMD, executionWorkspaceId: WS, cwdRelative: ".",
      argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000, dryRun: false,
    };
    const principal = { companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1", profileId: "rust-public-1" };
    expect((await broker.submit(request, principal)).status).toBe(202);
    sink.failToStart("repo is not on the offload allowlist");
    const read = await broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      state: "not_started", remoteStarted: false, fallbackSafe: true,
      fallbackReason: "repo is not on the offload allowlist",
    } satisfies Partial<OffloadReadResponse>);
  });

  it("recordRefusal bounds the journaled reason to 256 characters", async () => {
    const broker = new OffloadBroker({
      store: new MapStore(),
      backend: { start: () => { throw new Error("recordRefusal must not dispatch"); } },
      now: () => 1_000_000,
    });
    const request: OffloadSubmitRequest = {
      version: 1, commandId: CMD, executionWorkspaceId: WS, cwdRelative: ".",
      argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000, dryRun: false,
    };
    const principal = { companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1", profileId: "rust-public-1" };
    const long = `incompatible workload: ${"x".repeat(400)}`;
    await broker.recordRefusal(request, principal, long);
    const read = await broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0);
    expect(read.body).toMatchObject({ state: "not_started", fallbackReason: long.slice(0, 256) });
    expect((read.body as OffloadReadResponse).fallbackReason).toHaveLength(256);
  });

  it("executor backend forwards a reasoned refusal to failToStart verbatim", async () => {
    const output = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), failToStart: vi.fn(), fail: vi.fn() } satisfies OffloadOutputSink;
    const backend = new ExecutorBackend({
      resolveExecutor: async () => ({ refusalReason: "no offload binding for this run and workspace" }),
      pollIntervalMs: 1,
    });
    const command: BackendCommand = {
      commandId: CMD, companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1",
      profileId: "rust-public-1", executionWorkspaceId: WS, cwdRelative: ".",
      argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000,
    };
    const handle = backend.start(command, output);
    await handle.done;
    expect(output.failToStart).toHaveBeenCalledWith("no offload binding for this run and workspace");
    expect(output.started).not.toHaveBeenCalled();
  });

  it("executor admission refusals keep their specific reason (immediate and polled views)", async () => {
    const command: BackendCommand = {
      commandId: CMD, companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1",
      profileId: "rust-public-1", executionWorkspaceId: WS, cwdRelative: ".",
      argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000,
    };
    const notStarted = (fallbackReason: string) => ({
      version: 1 as const, commandId: CMD, state: "not_started" as const,
      remoteStarted: false, fallbackSafe: true, fallbackReason, result: null, events: [], nextCursor: 0,
    });
    // Immediate: start() itself acknowledges never-started (capacity admission).
    const immediateOutput = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), failToStart: vi.fn(), fail: vi.fn() } satisfies OffloadOutputSink;
    const immediateLog = vi.fn();
    const immediate = new ExecutorBackend({
      resolveExecutor: async () => ({
        start: async () => notStarted("queue full (32 pending)"),
        readOutput: async () => { throw new Error("no journal row to read"); },
        heartbeatCommand: async () => { throw new Error("unused"); },
        cancelCommand: async () => { throw new Error("unused"); },
      }),
      pollIntervalMs: 1,
      logRefusal: immediateLog,
    });
    await immediate.start(command, immediateOutput).done;
    expect(immediateOutput.failToStart).toHaveBeenCalledWith("queue full (32 pending)");
    expect(immediateLog).toHaveBeenCalledWith({ runId: RUN, workspaceId: WS, reason: "queue full (32 pending)" });

    // Polled: start() accepts, the first read turns terminal never-started.
    const polledOutput = { started: vi.fn(), write: vi.fn(), complete: vi.fn(), failToStart: vi.fn(), fail: vi.fn() } satisfies OffloadOutputSink;
    const polled = new ExecutorBackend({
      resolveExecutor: async () => ({
        start: async () => ({
          version: 1 as const, commandId: CMD, state: "queued" as const,
          remoteStarted: false, fallbackSafe: false, result: null, events: [], nextCursor: 0,
        }),
        readOutput: async () => notStarted("monthly offload VM-hour cap reached (10h); new commands run local until next month"),
        heartbeatCommand: async () => { throw new Error("unused"); },
        cancelCommand: async () => { throw new Error("unused"); },
      }),
      pollIntervalMs: 1,
    });
    await polled.start(command, polledOutput).done;
    expect(polledOutput.failToStart).toHaveBeenCalledWith("monthly offload VM-hour cap reached (10h); new commands run local until next month");
    expect(polledOutput.started).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- routes level

const ACTOR: RouteActor = { actorType: "agent", actorId: RUN, runId: RUN };

function routeHost(preflight: OffloadRouteHost["preflight"], realized = true): OffloadRouteHost {
  const broker = new OffloadBroker({
    store: new MapStore(),
    backend: { start: () => { throw new Error("must not dispatch on dry-run"); } },
    now: () => 1_000_000,
  });
  return {
    broker,
    workspaces: {
      get: async () => ({
        repoUrl: "https://github.com/example/public", projectId: "proj-1", projectWorkspaceId: "pws-1",
        path: realized ? "/work/repo" : null, cwd: realized ? "/work/repo" : null,
      }),
    },
    profile: { id: "rust-public-1", toolchains: ["stable", "1.99.1"], allowRustflags: false },
    preflight,
  };
}

function dryRunBody() {
  return {
    version: 1, commandId: CMD, executionWorkspaceId: WS, cwdRelative: ".",
    argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000, dryRun: true,
  };
}

describe("dry-run / real agreement", () => {
  it("(c) a preflight refusal turns the dry-run answer into local + the same reason", async () => {
    const host = routeHost(async () => "no offload binding for this run and workspace");
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: dryRunBody() }, host);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mode: "local", reason: "no offload binding for this run and workspace" });
  });

  it("(c) preflight passing keeps remote_candidate", async () => {
    const host = routeHost(async () => null);
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: dryRunBody() }, host);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mode: "remote_candidate" });
  });

  it("(c) a throwing preflight never promises remote", async () => {
    const host = routeHost(async () => { throw new Error("boom"); });
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: dryRunBody() }, host);
    expect(response.body).toMatchObject({ mode: "local", reason: "executor preflight unavailable" });
  });

  it("(c) an unrealized workspace is local on dry-run, matching the real submit's refusal", async () => {
    const host = routeHost(async () => null, false);
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: dryRunBody() }, host);
    expect(response.body).toMatchObject({ mode: "local", reason: "execution workspace is not locally realized; cannot snapshot source" });
  });
});

// ------------------------------------------------------------- runtime level

describe("runtime gate reasons", () => {
  const command: BackendCommand = {
    commandId: CMD, companyId: COMPANY, runId: RUN, cardId: "card-1",
    repoId: "repo:https://github.com/example/public", profileId: "rust-public-1",
    executionWorkspaceId: WS, cwdRelative: ".", argv: ["check", "--locked"],
    env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000,
  };

  function bareRuntime() {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const state = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    } as unknown as StateClientLike;
    const runtime = new SshOffloadRuntime({
      state, logger, ssh: {} as unknown as SshManager, accountId: "acct-1",
    });
    return { runtime, logger };
  }

  it("(d) each config/binding gate refuses with its own reason, and preflight agrees with resolve", async () => {
    const { runtime, logger } = bareRuntime();
    const cases: Array<{ settings: Record<string, unknown>; reason: string }> = [
      { settings: {}, reason: "offload executor is not enabled" },
      { settings: { offloadExecutorEnabled: true }, reason: "offload guest transport is not enabled" },
      {
        settings: { offloadExecutorEnabled: true, offloadGuestTransportEnabled: true },
        reason: "offload cgroup parent is not configured",
      },
      {
        settings: { offloadExecutorEnabled: true, offloadGuestTransportEnabled: true, offloadCgroupParent: "/sys/fs/cgroup/boat" },
        reason: "offload artifact root is not configured",
      },
      {
        settings: {
          offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
          offloadCgroupParent: "/sys/fs/cgroup/boat", offloadArtifactRoot: "/srv/boat/artifacts",
          offloadAllowedRepos: [],
        },
        reason: "repo is not on the offload allowlist",
      },
      {
        settings: {
          offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
          offloadCgroupParent: "/sys/fs/cgroup/boat", offloadArtifactRoot: "/srv/boat/artifacts",
          offloadAllowedRepos: ["repo:https://github.com/example/public"],
        },
        reason: "no offload binding for this run and workspace",
      },
    ];
    const seen = new Set<string>();
    for (const { settings, reason } of cases) {
      await expect(runtime.resolve(command, settings)).resolves.toEqual({ refusalReason: reason });
      await expect(runtime.preflight(command, settings)).resolves.toBe(reason);
      seen.add(reason);
    }
    expect(seen.size).toBe(cases.length); // every gate distinguishable
    // resolve (the real-submit path) logs each refusal once, with run + workspace + reason.
    expect(logger.info).toHaveBeenCalledTimes(cases.length);
    expect(logger.info).toHaveBeenCalledWith("boat: offload executor refused", {
      runId: RUN, workspaceId: WS, reason: "offload executor is not enabled",
    });
  });
});

// ------------------------------------------------------------ manager level

describe("manager preflight ordering", () => {
  it("a custom executor does not bypass the enabled opt-in on dry-run", async () => {
    const harness = createFakeContext();
    const manager = new BoatVmManager({
      state: harness.ctx.state, logger: harness.ctx.logger,
      offloadExecutor: async () => null,
    });
    try {
      const hostOf = (settings: Record<string, unknown>) => (manager as unknown as {
        offloadRouteHost(companyId: string, s?: Record<string, unknown>): {
          preflight(command: BackendCommand): Promise<string | null>;
        };
      }).offloadRouteHost(COMPANY, settings);
      const command: BackendCommand = {
        commandId: CMD, companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1",
        profileId: "rust-public-1", executionWorkspaceId: WS, cwdRelative: ".",
        argv: ["check", "--locked"], env: {}, queueTimeoutMs: 30_000, timeoutMs: 1_200_000,
      };
      // resolveExecutor refuses here even with a custom executor installed,
      // so preflight must refuse too instead of promising remote.
      await expect(hostOf({}).preflight(command)).resolves.toBe("offload executor is not enabled");
      await expect(hostOf({ offloadExecutorEnabled: true }).preflight(command)).resolves.toBeNull();
    } finally {
      await manager.shutdown().catch(() => undefined);
    }
  });
});
