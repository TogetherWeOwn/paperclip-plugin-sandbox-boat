import { describe, expect, it } from "vitest";
import { NeverDispatchBackend, OffloadBroker, type OffloadBackend, type OffloadJournalStore, type OffloadOutputSink } from "./broker.js";
import { canonicalRepoId, handleCancel, handleExec, handleHeartbeat, handleRead, type OffloadRouteHost, type RouteActor } from "./routes.js";

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

function setup(backend: OffloadBackend = new NeverDispatchBackend()) {
  const store = new MapStore();
  const starts: { sink: OffloadOutputSink }[] = [];
  const tracking = {
    start: (cmd: Parameters<OffloadBackend["start"]>[0], sink: OffloadOutputSink) => {
      starts.push({ sink });
      return backend.start(cmd, sink);
    },
  };
  const broker = new OffloadBroker({ store, backend: tracking, now: () => Date.parse("2026-10-23T10:00:00Z") });
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

  it("denies an unknown workspace before acceptance", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, {
      ...t.host,
      workspaces: { get: async () => null },
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "OFFLOAD_FORBIDDEN" });
    expect(t.starts.length).toBe(0);
    // Nothing journaled: the same ID submits cleanly once the workspace resolves.
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host)).status).toBe(202);
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
    ).toBe(403);
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
