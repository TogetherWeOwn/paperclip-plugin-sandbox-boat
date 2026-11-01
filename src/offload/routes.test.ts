import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeverDispatchBackend, OffloadBroker, type OffloadBackend, type OffloadJournalStore, type OffloadOutputSink } from "./broker.js";
import { canonicalRepoId, handleCancel, handleExec, handleHeartbeat, handleRead, V1_PROFILE, type OffloadRouteHost, type RouteActor } from "./routes.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

const ACTOR: RouteActor = { actorType: "agent", actorId: RUN, runId: RUN };

function submitBody(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: CMD,
    executionWorkspaceId: WS,
    cwdRelative: ".",
    argv: ["test", "--locked"],
    env: { CARGO_TERM_COLOR: "never" },
    queueTimeoutMs: 30000,
    timeoutMs: 1200000,
    dryRun: false,
    ...over,
  };
}

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

class RemoteBackend implements OffloadBackend {
  start(cmd: Parameters<OffloadBackend["start"]>[0], sink: OffloadOutputSink) {
    sink.started();
    return { done: new Promise<void>(() => {}), cancel: async () => {} };
  }
}

function setup(backend: OffloadBackend = new NeverDispatchBackend(), now: () => number = () => Date.parse("2026-10-23T10:00:00Z")) {
  const store = new MapStore();
  const starts: { sink: OffloadOutputSink }[] = [];
  const tracking = {
    start: (cmd: Parameters<OffloadBackend["start"]>[0], sink: OffloadOutputSink) => {
      starts.push({ sink });
      return backend.start(cmd, sink);
    },
  };
  const broker = new OffloadBroker({ store, backend: tracking, now });
  const workspaces = new Map<string, { repoUrl: string | null; projectId: string; projectWorkspaceId: string | null; path: string | null; cwd: string | null }>();
  workspaces.set(WS, { repoUrl: "https://github.com/TogetherWeOwn/two-bot-next", projectId: "proj-1", projectWorkspaceId: "pws-1", path: "/work/two-bot-next", cwd: "/work/two-bot-next" });
  const host: OffloadRouteHost = {
    broker,
    workspaces: { get: async (id: string) => workspaces.get(id) ?? null },
    profile: { id: "rust-public-1", toolchains: ["stable", "1.88.0"], allowRustflags: false },
  };
  return { store, host, workspaces, starts };
}

describe("handleExec", () => {
  it("accepts an eligible command bound to the run principal", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.status).toBe(202);
    // Same principal reads; another run is denied.
    expect((await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, query: {} }, t.host)).status).toBe(200);
    const other = await handleRead({ actor: { ...ACTOR, runId: "other-run" }, companyId: COMPANY, params: { commandId: CMD }, query: {} }, t.host);
    expect(other.status).toBe(403);
  });

  it("requires an agent actor with a run id", async () => {
    const t = setup();
    for (const actor of [{ actorType: "user", actorId: "u", runId: null }, { actorType: "agent", actorId: "a", runId: null }] as RouteActor[]) {
      const response = await handleExec({ actor, companyId: COMPANY, body: submitBody() }, t.host);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "OFFLOAD_UNAUTHORIZED" });
    }
    expect(t.starts.length).toBe(0);
  });

  it("falls back locally for an unknown workspace before acceptance", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, {
      ...t.host,
      workspaces: { get: async () => null },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(t.starts.length).toBe(0);
    // Nothing journaled: the same ID submits cleanly once the workspace resolves.
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
  });

  it("returns the journal verdict when the workspace binding disappears after acceptance", async () => {
    const t = setup(new RemoteBackend());
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
    // Flush the backend's started callback through the journal before the binding disappears.
    expect(await t.host.broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0)).toMatchObject({
      status: 200, body: { state: "running", remoteStarted: true, fallbackSafe: false },
    });
    t.workspaces.delete(WS);
    const retry = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ state: "running", remoteStarted: true, fallbackSafe: false });
    expect(t.starts.length).toBe(1);
  });

  it("never answers fallbackSafe for an ID accepted while its workspace lookup was in flight", async () => {
    const t = setup(new RemoteBackend());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lookups = 0;
    const racingHost = {
      ...t.host,
      workspaces: {
        get: async (id: string) => {
          lookups += 1;
          // The first request's lookup is slow and misses; the binding is
          // visible by the time the concurrent retry looks it up.
          if (lookups === 1) { await gate; return null; }
          return t.workspaces.get(id) ?? null;
        },
      },
    };
    const first = handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, racingHost);
    // The retry is accepted and starts while the first request still waits.
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, racingHost)).status).toBe(202);
    expect(await t.host.broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0)).toMatchObject({
      status: 200, body: { state: "running", remoteStarted: true, fallbackSafe: false },
    });
    release();
    // The early journal check saw an unused ID, so the stale lookup must not
    // turn into a fallback-safe 503 over the running command.
    const raced = await first;
    expect(raced.status).toBe(200);
    expect(raced.body).toMatchObject({ state: "running", remoteStarted: true, fallbackSafe: false });
    expect(t.starts.length).toBe(1);
  });

  it("answers 409 when a lost binding resubmits the same ID with a different payload", async () => {
    const t = setup(new RemoteBackend());
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
    expect(await t.host.broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0)).toMatchObject({
      status: 200, body: { state: "running" },
    });
    t.workspaces.delete(WS);
    const retry = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv: ["build", "--locked"] }) }, t.host);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    expect(t.starts.length).toBe(1);
  });

  it("answers 410 instead of 503 when an expired ID resubmits after the binding disappears", async () => {
    let now = Date.parse("2026-10-23T10:00:00Z");
    const t = setup(new NeverDispatchBackend(), () => now);
    // The backend refuses before any spawn, journaling a terminal never-started receipt.
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
    now += 25 * 60 * 60_000;
    await t.host.broker.collectGarbage();
    t.workspaces.delete(WS);
    const retry = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(retry.status).toBe(410);
    expect(retry.body).toMatchObject({ code: "OFFLOAD_RESULT_EXPIRED" });
    expect(t.starts.length).toBe(1);
  });

  it("returns unavailable with a never-started receipt when confinement is unsupported", async () => {
    const t = setup();
    t.workspaces.set(WS, { repoUrl: null, projectId: "proj-1", projectWorkspaceId: null, path: null, cwd: null });
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(t.starts.length).toBe(0);
    const view = await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, query: {} }, t.host);
    expect(view.body).toMatchObject({ state: "not_started", fallbackSafe: true });
  });

  it("refuses router-local argv as an incompatible workload with a receipt", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv: ["fmt", "--check"] }) }, t.host);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true });
    expect(t.starts.length).toBe(0);
    const view = await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, query: {} }, t.host);
    expect(view.body).toMatchObject({ state: "not_started" });
  });

  it("answers the documented 409 when a refusal reuses an ID with a different payload", async () => {
    const t = setup();
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
    const refusal = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv: ["fmt"] }) }, t.host);
    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
    t.workspaces.set(WS, { repoUrl: null, projectId: "p", projectWorkspaceId: null, path: null, cwd: null });
    const unrealized = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv: ["check"] }) }, t.host);
    expect(unrealized.status).toBe(409);
  });

  it("rejects invalid bodies and oversized raw bodies", async () => {
    const t = setup();
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ shell: true }) }, t.host)).status).toBe(400);
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ env: { CARGO_TERM_COLOR: "x".repeat(70 * 1024) } }) }, t.host)).status).toBe(400);
    expect(t.starts.length).toBe(0);
  });

  it("rejects argv controls with 400 before workspace lookup, journaling or dispatch", async () => {
    const t = setup();
    let lookups = 0;
    const workspaces = t.host.workspaces;
    t.host.workspaces = { get: async () => { lookups++; return null; } };
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      const response = await handleExec({ actor: ACTOR, companyId: COMPANY,
        body: submitBody({ argv: ["test", `filter${String.fromCharCode(code)}suffix`] }) }, t.host);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "OFFLOAD_INVALID_REQUEST" });
    }
    expect(lookups).toBe(0);
    expect(t.starts).toHaveLength(0);
    expect(t.store.data.size).toBe(0);
    // Rejected input never reserves the command ID.
    t.host.workspaces = workspaces;
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
  });

  it("rejects secret canaries and never journals secret values", async () => {
    const t = setup();
    const canary = "canary-gh-token-9f8e7d6c5b4a";
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ env: { GITHUB_TOKEN: canary } }) }, t.host);
    expect(response.status).toBe(400);
    await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(JSON.stringify([...t.store.data.values()])).not.toContain("canary");
    expect(JSON.stringify(response.body)).not.toContain(canary);
  });

  it("dry-runs with zero broker effects", async () => {
    const t = setup();
    const remote = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ dryRun: true }) }, t.host);
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({ version: 1, commandId: CMD, mode: "remote_candidate", profileId: "rust-public-1" });
    const local = await handleExec(
      { actor: ACTOR, companyId: COMPANY, body: submitBody({ commandId: "00000000-0000-4000-8000-000000000001", argv: ["fmt"], dryRun: true }) },
      t.host,
    );
    expect(local.body).toMatchObject({ mode: "local" });
    expect(t.starts.length).toBe(0);
    expect(t.store.data.size).toBe(0);
  });

  it("dry-run still validates and binds the workspace", async () => {
    const t = setup();
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ dryRun: true, version: 9 }) }, t.host)).status).toBe(400);
    expect(
      (await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ dryRun: true }) }, { ...t.host, workspaces: { get: async () => null } })).status,
    ).toBe(503);
  });
});

describe("rust-public-1 profile parity", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function workspaceWith(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "boat-toolchain-"));
    roots.push(root);
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
    return root;
  }
  async function dryRun(root: string, argv: string[], cwdRelative = ".") {
    const t = setup();
    t.host.profile = V1_PROFILE;
    t.workspaces.set(WS, { repoUrl: "https://github.com/TogetherWeOwn/two-bot-next", projectId: "proj-1", projectWorkspaceId: "pws-1", path: root, cwd: root });
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv, dryRun: true, cwdRelative }) }, t.host);
    expect(response.status).toBe(200);
    return response.body as { mode: string; reason: string };
  }
  const TWO_BOT_NEXT_TOOLCHAIN = '# Pinned toolchain\n[toolchain]\nchannel = "1.98.1"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

  it("pins 1.98.1 with clippy and owns the lean build env", () => {
    expect(V1_PROFILE.toolchains).toContain("1.98.1");
    expect(V1_PROFILE.components).toContain("clippy");
    expect(V1_PROFILE.env).toEqual({ CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0" });
    // Host paths from the local wrapper never become guest env.
    expect(Object.keys(V1_PROFILE.env!).some((key) => /TARGET_DIR|BUILD_DIR|TMP|SCRATCH/.test(key))).toBe(false);
  });

  it("classifies two-bot-next's wrapper argv as remote candidates on its pinned toolchain", async () => {
    const root = workspaceWith({ "rust-toolchain.toml": TWO_BOT_NEXT_TOOLCHAIN });
    for (const sub of ["check", "test", "clippy", "build"]) {
      // cargo_cache.py inserts --offline --locked after the subcommand.
      expect((await dryRun(root, [sub, "--offline", "--locked", "--workspace"])).mode).toBe("remote_candidate");
    }
    expect((await dryRun(root, ["fmt", "--check"])).mode).toBe("local");
  });

  it("keeps a workspace pinned to an uninstalled or unparseable toolchain local", async () => {
    const pinned = await dryRun(workspaceWith({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.99.0"\n' }), ["check"]);
    expect(pinned).toMatchObject({ mode: "local", reason: "rust-toolchain.toml pins 1.99.0, not installed on the profile" });
    expect((await dryRun(workspaceWith({ "rust-toolchain": "nightly-2026-01-01\n" }), ["check"])).mode).toBe("local");
    expect((await dryRun(workspaceWith({ "rust-toolchain.toml": '[toolchain]\npath = "/opt/rust"\n' }), ["check"])).mode).toBe("local");
    expect((await dryRun(workspaceWith({ "rust-toolchain": "1.98.1" }), ["check"])).mode).toBe("remote_candidate");
    // rustup reads the legacy file when both exist.
    expect(await dryRun(workspaceWith({ "rust-toolchain": "1.99.0", "rust-toolchain.toml": TWO_BOT_NEXT_TOOLCHAIN }), ["check"]))
      .toMatchObject({ mode: "local", reason: "rust-toolchain pins 1.99.0, not installed on the profile" });
    expect((await dryRun(workspaceWith({ "rust-toolchain": "1.98.1", "rust-toolchain.toml": '[toolchain]\nchannel = "1.99.0"\n' }), ["check"])).mode)
      .toBe("remote_candidate");
    // An explicit installed +toolchain overrides the file, as rustup does.
    expect((await dryRun(workspaceWith({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.99.0"\n' }), ["+1.98.1", "check"])).mode).toBe("remote_candidate");
  });

  it("uses the toolchain file nearest the run directory", async () => {
    const root = workspaceWith({ "rust-toolchain.toml": TWO_BOT_NEXT_TOOLCHAIN });
    mkdirSync(path.join(root, "crates", "foo", "src"), { recursive: true });
    writeFileSync(path.join(root, "crates", "foo", "rust-toolchain"), "1.99.0");
    expect((await dryRun(root, ["check"], "crates")).mode).toBe("remote_candidate");
    expect(await dryRun(root, ["check"], "crates/foo/src")).toMatchObject({ mode: "local", reason: "rust-toolchain pins 1.99.0, not installed on the profile" });
  });

  it("keeps test runs that reach agent-testdb without any env local", async () => {
    const root = workspaceWith({ "rust-toolchain.toml": TWO_BOT_NEXT_TOOLCHAIN });
    const cases: Array<[string[], RegExp]> = [
      [["test", "--offline", "--locked", "--workspace", "--lib", "--bins", "--features", "two-bot-core/db"], /^feature two-bot-core\/db /],
      [["test", "-p", "two-bot-core", "--features=db", "--test", "custom_command_store"], /^feature db /],
      [["test", "-p", "two-bot-core", "-F", "serde,db"], /^feature db /],
      [["test", "--workspace", "--all-features"], /^--all-features /],
      [["test", "-p", "two-bot-core", "--lib", "--", "--ignored"], /^ignored tests /],
      [["test", "--", "--include-ignored"], /^ignored tests /],
      [["nextest", "run", "--run-ignored", "all"], /^ignored tests /],
    ];
    for (const [argv, reason] of cases) {
      expect(await dryRun(root, argv)).toMatchObject({ mode: "local", reason: expect.stringMatching(reason) });
    }
    // Compile-only commands with the feature never run tests: still eligible.
    for (const argv of [["clippy", "--workspace", "--all-targets", "--all-features"], ["check", "--features", "two-bot-core/db"],
      ["build", "--all-features"], ["test", "--features", "dashboard"], ["test", "-p", "two-bot", "--", "--test-threads=1"]]) {
      expect((await dryRun(root, argv)).mode).toBe("remote_candidate");
    }
  });

  it("keeps clippy local on a profile without the clippy component", async () => {
    const t = setup();
    t.host.profile = { ...V1_PROFILE, components: [] };
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ argv: ["clippy"], dryRun: true }) }, t.host);
    expect(response.body).toMatchObject({ mode: "local", reason: "clippy is not installed on the profile" });
  });
});

describe("handleRead/handleHeartbeat/handleCancel", () => {
  it("requires agent auth and a UUID command id", async () => {
    const t = setup();
    await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    const anon = { actorType: "user", actorId: "u", runId: null } as RouteActor;
    expect((await handleRead({ actor: anon, companyId: COMPANY, params: { commandId: CMD }, query: {} }, t.host)).status).toBe(401);
    expect((await handleHeartbeat({ actor: anon, companyId: COMPANY, params: { commandId: CMD } }, t.host)).status).toBe(401);
    expect((await handleCancel({ actor: anon, companyId: COMPANY, params: { commandId: CMD }, body: {} }, t.host)).status).toBe(401);
    expect((await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: "nope" }, query: {} }, t.host)).status).toBe(400);
  });

  it("rejects a non-numeric cursor and clamps the byte limit", async () => {
    const t = setup();
    await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect((await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, query: { after: "soon" } }, t.host)).status).toBe(400);
    const clamped = await handleRead({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, query: { after: "0", limitBytes: "99999999" } }, t.host);
    expect(clamped.status).toBe(200);
  });

  it("passes heartbeat and cancel through to the broker", async () => {
    const t = setup();
    await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect((await handleHeartbeat({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD } }, t.host)).status).toBe(200);
    const cancelled = await handleCancel({ actor: ACTOR, companyId: COMPANY, params: { commandId: CMD }, body: { reason: "client_signal" } }, t.host);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ state: "not_started" });
  });
});

describe("canonicalRepoId", () => {
  it("is stable across URL spellings and falls back to the project", () => {
    expect(canonicalRepoId({ repoUrl: "https://github.com/TogetherWeOwn/two-bot-next.git", projectId: "p" })).toBe(
      canonicalRepoId({ repoUrl: "https://github.com/TogetherWeOwn/two-bot-next", projectId: "p" }),
    );
    expect(canonicalRepoId({ repoUrl: null, projectId: "proj-1" })).toBe("project:proj-1");
  });
});
