import { describe, expect, it } from "vitest";
import { NeverDispatchBackend, OffloadBroker, type OffloadBackend, type OffloadJournalStore, type OffloadOutputSink } from "./broker.js";
import { durationKey, normalizeSignature } from "./duration-history.js";
import {
  NODE_PROFILE,
  PYTHON_PROFILE,
  canonicalRepoId,
  handleExec,
  handleReport,
  normalizeOffloadSettings,
  type OffloadRouteHost,
  type RouteActor,
} from "./routes.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CMD = "7d82278c-2ba7-4e68-96ab-c2cc10d697af";
const WS = "b9d0e6ac-a14d-4444-a324-7dcdd758be08";

const ACTOR: RouteActor = { actorType: "agent", actorId: RUN, runId: RUN };

function submitBody(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: CMD,
    executionWorkspaceId: WS,
    cwdRelative: ".",
    tool: "node",
    runner: "npm",
    argv: ["run", "test"],
    env: {},
    queueTimeoutMs: 30000,
    timeoutMs: 1200000,
    dryRun: true,
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

function setup(backend: OffloadBackend = new NeverDispatchBackend(), settings?: Record<string, unknown>) {
  const store = new MapStore();
  const broker = new OffloadBroker({ store, backend, now: () => Date.parse("2026-10-26T10:00:00Z") });
  const workspaces = new Map<string, { repoUrl: string | null; projectId: string; projectWorkspaceId: string | null; path: string | null; cwd: string | null }>();
  workspaces.set(WS, { repoUrl: "https://github.com/example/app", projectId: "proj-1", projectWorkspaceId: "pws-1", path: "/work/app", cwd: "/work/app" });
  const host: OffloadRouteHost = {
    broker,
    workspaces: { get: async (id: string) => workspaces.get(id) ?? null },
    profile: { id: "rust-public-1", toolchains: ["stable"], allowRustflags: false },
    extraProfiles: [NODE_PROFILE, PYTHON_PROFILE],
    settings: normalizeOffloadSettings(settings ?? { offloadProfiles: ["rust-public-1", "node-public-1", "python-public-1"] }),
    durations: store,
  };
  return { store, host };
}

describe("normalizeOffloadSettings", () => {
  it("defaults to rust-only with a 120s threshold", () => {
    expect(normalizeOffloadSettings({})).toEqual({ offloadProfiles: ["rust-public-1"], offloadMinExpectedSeconds: 120 });
    expect(normalizeOffloadSettings(null)).toEqual({ offloadProfiles: ["rust-public-1"], offloadMinExpectedSeconds: 120 });
  });

  it("keeps known profiles and drops unknown ones and bad thresholds", () => {
    expect(normalizeOffloadSettings({ offloadProfiles: ["node-public-1", "nope"], offloadMinExpectedSeconds: -5 }))
      .toEqual({ offloadProfiles: ["node-public-1"], offloadMinExpectedSeconds: 120 });
    expect(normalizeOffloadSettings({ offloadMinExpectedSeconds: 60 }).offloadMinExpectedSeconds).toBe(60);
  });
});

describe("handleExec node/python gating", () => {
  it("rejects an unknown tool", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ tool: "go" }) }, t.host);
    expect(response.status).toBe(400);
  });

  it("rejects a runner that is not on the profile", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ runner: "bun" }) }, t.host);
    expect(response.status).toBe(400);
  });

  it("keeps node local when the profile is not enabled", async () => {
    const t = setup(new NeverDispatchBackend(), {});
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true });
  });

  it("keeps node local with no duration history yet", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mode: "local", profileId: "node-public-1" });
  });

  it("keeps node local below the median threshold", async () => {
    const t = setup();
    const repoId = canonicalRepoId({ repoUrl: "https://github.com/example/app", projectId: "proj-1" });
    await t.store.set(durationKey(repoId, "node-public-1", normalizeSignature("node", "npm", ["run", "test"])),
      [{ seconds: 30, at: Date.parse("2026-10-26T09:00:00Z") }, { seconds: 40, at: Date.parse("2026-10-26T09:30:00Z") }]);
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.body).toMatchObject({ mode: "local", profileId: "node-public-1" });
  });

  it("routes node remote at/above the median threshold", async () => {
    const t = setup();
    const repoId = canonicalRepoId({ repoUrl: "https://github.com/example/app", projectId: "proj-1" });
    await t.store.set(durationKey(repoId, "node-public-1", normalizeSignature("node", "npm", ["run", "test"])),
      [{ seconds: 200, at: Date.parse("2026-10-26T09:00:00Z") }, { seconds: 400, at: Date.parse("2026-10-26T09:30:00Z") }]);
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(response.body).toMatchObject({ mode: "remote_candidate", profileId: "node-public-1" });
  });

  it("routes python remote with history, and classifies narrow selections local", async () => {
    const t = setup();
    const repoId = canonicalRepoId({ repoUrl: "https://github.com/example/app", projectId: "proj-1" });
    await t.store.set(durationKey(repoId, "python-public-1", normalizeSignature("python", "pytest", ["tests/"])),
      [{ seconds: 300, at: Date.parse("2026-10-26T09:00:00Z") }]);
    const remote = await handleExec(
      { actor: ACTOR, companyId: COMPANY, body: submitBody({ tool: "python", runner: "pytest", argv: ["tests/"] }) }, t.host);
    expect(remote.body).toMatchObject({ mode: "remote_candidate", profileId: "python-public-1" });
    const narrow = await handleExec(
      { actor: ACTOR, companyId: COMPANY, body: submitBody({ tool: "python", runner: "pytest", argv: ["tests/test_a.py::test_x"] }) }, t.host);
    expect(narrow.body).toMatchObject({ mode: "local" });
  });

  it("leaves cargo behaviour unchanged (no duration gate)", async () => {
    const t = setup(new NeverDispatchBackend(), {});
    const response = await handleExec({
      actor: ACTOR,
      companyId: COMPANY,
      body: { ...submitBody(), tool: undefined, runner: undefined, argv: ["test", "--locked"], env: { CARGO_TERM_COLOR: "never" } },
    }, t.host);
    expect(response.body).toMatchObject({ mode: "remote_candidate", profileId: "rust-public-1" });
    const starts: { sink: OffloadOutputSink }[] = [];
    void starts;
  });
});

describe("handleReport", () => {
  it("records a local duration and promotes the next dry-run to remote", async () => {
    const t = setup();
    const report = await handleReport({
      actor: ACTOR,
      companyId: COMPANY,
      body: { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", "test"], durationSeconds: 240 },
    }, t.host);
    expect(report).toMatchObject({ status: 200 });
    const next = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(next.body).toMatchObject({ mode: "remote_candidate" });
  });

  it("rejects bad reports", async () => {
    const t = setup();
    const base = { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", "test"], durationSeconds: 240 };
    for (const body of [
      { ...base, tool: "cargo" },
      { ...base, runner: "bun" },
      { ...base, argv: [] },
      { ...base, durationSeconds: -1 },
      { ...base, executionWorkspaceId: "not-a-uuid" },
    ]) {
      expect((await handleReport({ actor: ACTOR, companyId: COMPANY, body }, t.host)).status).toBe(400);
    }
    expect((await handleReport({ actor: { ...ACTOR, runId: null }, companyId: COMPANY, body: base }, t.host)).status).toBe(401);
    expect((await handleReport({ actor: ACTOR, companyId: COMPANY, body: { ...base, executionWorkspaceId: CMD } }, { ...t.host, workspaces: { get: async () => null } })).status).toBe(403);
  });
});
