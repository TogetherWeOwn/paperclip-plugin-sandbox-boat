import { beforeEach, describe, expect, it } from "vitest";
import { NeverDispatchBackend, OffloadBroker, type BackendCommand, type OffloadBackend, type OffloadJournalStore, type OffloadOutputSink } from "./broker.js";
import { DURATION_INDEX_KEY, DURATION_INDEX_LIMIT, durationKey, normalizeSignature } from "./duration-history.js";
import {
  NODE_PROFILE,
  PYTHON_PROFILE,
  canonicalRepoId,
  handleExec,
  handleReport,
  handleVerify,
  normalizeOffloadSettings,
  resetReportBudgets,
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
    // Test-only: this fixture exercises classifier/receipt/preflight behavior, not exact-run admission.
    // The real security gate is covered by admission.test.ts.
    admission: { check: async () => null, consume: async () => null },
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
    expect(normalizeOffloadSettings({})).toEqual({ offloadProfiles: ["rust-public-1"], offloadMinExpectedSeconds: 120, offloadMonthlyVmHourCap: 0, offloadEphemeralRepos: [] });
    expect(normalizeOffloadSettings(null)).toEqual({ offloadProfiles: ["rust-public-1"], offloadMinExpectedSeconds: 120, offloadMonthlyVmHourCap: 0, offloadEphemeralRepos: [] });
  });

  it("keeps known profiles and drops unknown ones and bad thresholds", () => {
    expect(normalizeOffloadSettings({ offloadProfiles: ["node-public-1", "nope"], offloadMinExpectedSeconds: -5 }))
      .toEqual({ offloadProfiles: ["node-public-1"], offloadMinExpectedSeconds: 120, offloadMonthlyVmHourCap: 0, offloadEphemeralRepos: [] });
    expect(normalizeOffloadSettings({ offloadMinExpectedSeconds: 60 }).offloadMinExpectedSeconds).toBe(60);
    expect(normalizeOffloadSettings({ offloadMinExpectedSeconds: 0 }).offloadMinExpectedSeconds).toBe(0);
  });

  it.each([null, false, "", "0", [], {}, NaN, Infinity, -1])("does not coerce malformed threshold %j into opt-out", (value) => {
    expect(normalizeOffloadSettings({ offloadMinExpectedSeconds: value }).offloadMinExpectedSeconds).toBe(120);
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

  it.each([
    { tool: "node", runner: "npx", argv: ["next", "build"], profileId: "node-public-1" },
    { tool: "python", runner: "pytest", argv: ["tests/"], profileId: "python-public-1" },
  ])("bootstraps $tool at an explicit zero threshold without fabricated history", async ({ profileId, ...command }) => {
    const t = setup(new NeverDispatchBackend(), { offloadProfiles: [profileId], offloadMinExpectedSeconds: 0 });
    // Neither absent nor unavailable learning may force a local training run
    // when the operator has explicitly disabled the performance threshold.
    for (const durations of [t.store, undefined]) {
      const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody(command) }, { ...t.host, durations });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ mode: "remote_candidate", profileId });
    }
    expect(t.store.data.size).toBe(0);
  });

  it("retains local-first learning when the threshold is positive", async () => {
    const t = setup();
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, { ...t.host, durations: undefined });
    expect(response.body).toMatchObject({ mode: "local", reason: "duration learning unavailable; run local first" });
  });

  it("does not consult broken learning storage with an explicit zero threshold", async () => {
    const t = setup(new NeverDispatchBackend(), { offloadProfiles: ["node-public-1"], offloadMinExpectedSeconds: 0 });
    const response = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, {
      ...t.host,
      durations: { ...t.store, get: async () => { throw new Error("learning unavailable"); }, set: async () => { throw new Error("must not fabricate a sample"); }, delete: async () => {} },
    });
    expect(response.body).toMatchObject({ mode: "remote_candidate" });
    expect(t.store.data.size).toBe(0);
  });

  it("still applies profile, source, classifier and executor preflight gates at zero", async () => {
    const t = setup(new NeverDispatchBackend(), { offloadProfiles: ["node-public-1"], offloadMinExpectedSeconds: 0 });
    const call = (body: Record<string, unknown>, host = t.host) => handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody(body) }, host);
    expect((await call({ tool: "python", runner: "pytest", argv: ["tests/"] })).body)
      .toMatchObject({ code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true });
    expect((await call({ argv: ["run", "dev"] })).body).toMatchObject({ mode: "local" });
    expect((await call({ env: { DATABASE_URL: "not-forwarded" } })).status).toBe(400);
    expect((await call({}, { ...t.host, workspaces: { get: async () => null } })).body)
      .toMatchObject({ code: "OFFLOAD_UNAVAILABLE", fallbackSafe: true });
    expect((await call({}, { ...t.host, preflight: async () => "included capacity unavailable" })).body)
      .toMatchObject({ mode: "local", reason: "included capacity unavailable" });
    expect(t.store.data.size).toBe(0);
  });

  it("submits a zero-threshold command once with its original timeout and no duration sample", async () => {
    const started: BackendCommand[] = [];
    const backend: OffloadBackend = {
      start: (command, sink) => {
        started.push(command);
        sink.started();
        return { done: new Promise<void>(() => {}), cancel: async () => {} };
      },
    };
    const t = setup(backend, { offloadProfiles: ["node-public-1"], offloadMinExpectedSeconds: 0 });
    const body = submitBody({ dryRun: false, timeoutMs: 1800000 });
    const first = await handleExec({ actor: ACTOR, companyId: COMPANY, body }, t.host);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ fallbackSafe: false });
    expect(await t.host.broker.read(CMD, { companyId: COMPANY, runId: RUN }, 0)).toMatchObject({
      status: 200, body: { state: "running", remoteStarted: true, fallbackSafe: false },
    });
    const retry = await handleExec({ actor: ACTOR, companyId: COMPANY, body }, t.host);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ remoteStarted: true, fallbackSafe: false });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ tool: "node", runner: "npm", timeoutMs: 1800000 });
    expect([...t.store.data.keys()].some((key) => key === DURATION_INDEX_KEY)).toBe(false);
  });

  it.each([false, true])("preserves Python selection through preflight and backend (selected=%s)", async (selected) => {
    const started: BackendCommand[] = [];
    const preflight: BackendCommand[] = [];
    const t = setup({ start: (command) => {
      started.push(command);
      return { done: Promise.resolve(), cancel: async () => {} };
    } }, { offloadProfiles: ["python-public-1"], offloadMinExpectedSeconds: 0 });
    t.host.preflight = async (command) => { preflight.push(command); return null; };
    const depSelection = { uvExtra: "test", cwdRelative: "tests/unit" };
    const body = submitBody({ tool: "python", runner: "pytest", argv: ["tests/"], cwdRelative: "tests/unit",
      ...(selected ? { depSelection } : {}) });
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body }, t.host)).status).toBe(200);
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: { ...body, dryRun: false } }, t.host)).status).toBe(202);
    expect(started).toHaveLength(1);
    for (const command of [...preflight, ...started]) {
      expect(command.cwdRelative).toBe("tests/unit");
      if (selected) expect(command.depSelection).toEqual(depSelection);
      else expect(command).not.toHaveProperty("depSelection");
    }
    const restarted = new OffloadBroker({ store: t.store, backend: { start: () => { throw new Error("must not replay"); } }, now: () => Date.now() });
    const receiptOnlyHost: OffloadRouteHost = { ...t.host, broker: restarted, settings: normalizeOffloadSettings({}),
      admission: undefined, workspaces: { get: async () => { throw new Error("receipt must not resolve source"); } },
      preflight: async () => { throw new Error("receipt must not preflight"); } };
    const verify = (payload: Record<string, unknown>) => handleVerify({ actor: ACTOR, companyId: COMPANY,
      params: { commandId: CMD }, body: payload }, receiptOnlyHost);
    expect((await verify({ ...body, dryRun: false })).status).toBe(200);
    const changed = { ...body, dryRun: false, ...(selected ? { depSelection: undefined } : { depSelection }) };
    expect((await verify(changed)).status).toBe(409);
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: changed }, { ...t.host, broker: restarted })).body)
      .toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT", fallbackSafe: false });
    const moved = { ...body, dryRun: false, cwdRelative: "tests/other",
      ...(selected ? { depSelection: { ...depSelection, cwdRelative: "tests/other" } } : {}) };
    expect((await verify(moved)).status).toBe(409);
    expect((await handleExec({ actor: ACTOR, companyId: COMPANY, body: moved }, { ...t.host, broker: restarted })).status).toBe(409);
  });

  it("refuses malformed selection at the route before preflight or dispatch", async () => {
    const t = setup();
    let preflightCalls = 0;
    t.host.preflight = async () => { preflightCalls++; return null; };
    for (const depSelection of [null, { uvExtra: "dev", cwdRelative: "." }, { uvExtra: "test", cwdRelative: "elsewhere" },
      { uvExtra: "test", cwdRelative: ".", unknown: true }]) {
      expect((await handleExec({ actor: ACTOR, companyId: COMPANY,
        body: submitBody({ tool: "python", runner: "pytest", argv: ["tests/"], depSelection }) }, t.host)).status).toBe(400);
    }
    expect(preflightCalls).toBe(0);
    expect(t.store.data.size).toBe(0);
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

  it("normalises an omitted runner before submission, so real exec matches the dry-run", async () => {
    const started: BackendCommand[] = [];
    const backend: OffloadBackend = {
      start: (command) => {
        started.push(command);
        return { done: Promise.resolve(), cancel: async () => {} };
      },
    };
    const t = setup(backend);
    const repoId = canonicalRepoId({ repoUrl: "https://github.com/example/app", projectId: "proj-1" });
    await t.store.set(durationKey(repoId, "node-public-1", normalizeSignature("node", "npm", ["run", "test"])),
      [{ seconds: 300, at: Date.parse("2026-10-26T09:00:00Z") }]);
    const dry = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ runner: undefined }) }, t.host);
    expect(dry.body).toMatchObject({ mode: "remote_candidate", profileId: "node-public-1" });
    const real = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ runner: undefined, dryRun: false }) }, t.host);
    expect(real.status).toBe(202);
    // The broker would default an omitted runner to cargo; the route must
    // hand it the same npm runner the dry-run judged.
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ tool: "node", runner: "npm" });
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
  // The per-run rate budget is module-global; reset it so report tests never
  // depend on each other's consumption.
  beforeEach(() => { resetReportBudgets(); });

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

  it.each([false, true])("isolates selected and default Python duration reports (selected=%s)", async (selected) => {
    const t = setup();
    const command = { tool: "python", runner: "pytest", argv: ["tests/"], cwdRelative: "." };
    const depSelection = { uvExtra: "test", cwdRelative: "." };
    const selection = selected ? { depSelection } : {};
    expect((await handleReport({ actor: ACTOR, companyId: COMPANY,
      body: { executionWorkspaceId: WS, ...command, ...selection, durationSeconds: 240 } }, t.host)).status).toBe(200);
    for (const dryRun of [true, false]) {
      const other = await handleExec({ actor: ACTOR, companyId: COMPANY,
        body: submitBody({ ...command, ...(selected ? {} : { depSelection }), dryRun }) }, t.host);
      expect(other.status).toBe(dryRun ? 200 : 503);
      if (dryRun) expect(other.body).toMatchObject({ mode: "local", reason: "no duration history yet; run local first and record" });
    }
    const same = await handleExec({ actor: ACTOR, companyId: COMPANY,
      body: submitBody({ ...command, ...selection }) }, t.host);
    expect(same.body).toMatchObject({ mode: "remote_candidate" });
  });

  it.each([
    null, [], { uvExtra: "dev", cwdRelative: "." }, { uvExtra: "test", cwdRelative: "other" },
    { uvExtra: "test", cwdRelative: ".", unknown: true }, { uvExtra: "test" },
  ])("rejects malformed report selection before storage: %j", async (depSelection) => {
    const t = setup();
    expect((await handleReport({ actor: ACTOR, companyId: COMPANY,
      body: { executionWorkspaceId: WS, tool: "python", runner: "pytest", argv: ["tests/"],
        cwdRelative: ".", depSelection, durationSeconds: 240 } }, t.host)).status).toBe(400);
    expect(t.store.data.size).toBe(0);
  });

  it("rejects a Python selection on a Node duration report", async () => {
    const t = setup();
    expect((await handleReport({ actor: ACTOR, companyId: COMPANY,
      body: { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", "test"],
        depSelection: { uvExtra: "test", cwdRelative: "." }, durationSeconds: 240 } }, t.host)).status).toBe(400);
    expect(t.store.data.size).toBe(0);
  });

  it("keeps duration history per run directory", async () => {
    const t = setup();
    const report = await handleReport({
      actor: ACTOR,
      companyId: COMPANY,
      body: { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", "test"], cwdRelative: "packages/slow", durationSeconds: 240 },
    }, t.host);
    expect(report).toMatchObject({ status: 200 });
    const root = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody() }, t.host);
    expect(root.body).toMatchObject({ mode: "local" });
    const slow = await handleExec({ actor: ACTOR, companyId: COMPANY, body: submitBody({ cwdRelative: "packages/slow" }) }, t.host);
    expect(slow.body).toMatchObject({ mode: "remote_candidate" });
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
      { ...base, cwdRelative: "../outside" },
      { ...base, cwdRelative: 7 },
    ]) {
      expect((await handleReport({ actor: ACTOR, companyId: COMPANY, body }, t.host)).status).toBe(400);
    }
    expect((await handleReport({ actor: { ...ACTOR, runId: null }, companyId: COMPANY, body: base }, t.host)).status).toBe(401);
    expect((await handleReport({ actor: ACTOR, companyId: COMPANY, body: { ...base, executionWorkspaceId: CMD } }, { ...t.host, workspaces: { get: async () => null } })).status).toBe(403);
  });

  it("refuses local-mode signatures before any state write", async () => {
    const t = setup();
    for (const argv of [["run", "dev"], ["run", "test", "--watch"]]) {
      const response = await handleReport({
        actor: ACTOR,
        companyId: COMPANY,
        body: { executionWorkspaceId: WS, tool: "node", runner: "npm", argv, durationSeconds: 240 },
      }, t.host);
      expect(response.status).toBe(400);
    }
    expect(t.store.data.size).toBe(0);
  });

  it("caps stored keys when a thousand unique signatures report", async () => {
    const t = setup();
    for (let i = 0; i < 1000; i += 1) {
      // Distinct runs: the per-run budget must not mask the key cap.
      const runId = `report-run-${i}`;
      const response = await handleReport({
        actor: { actorType: "agent", actorId: runId, runId },
        companyId: COMPANY,
        body: { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", `test:${i}`], durationSeconds: 240 },
      }, t.host);
      expect(response.status).toBe(200);
    }
    const keys = [...t.store.data.keys()].filter((key) => key !== DURATION_INDEX_KEY);
    expect(keys.length).toBeLessThanOrEqual(DURATION_INDEX_LIMIT);
    expect(keys.length).toBeGreaterThan(0);
    // Evicted keys are deleted, not just unindexed.
    expect(t.store.data.size).toBe(keys.length + 1);
  });

  it("rate-limits a run that floods reports", async () => {
    const t = setup();
    const body = { executionWorkspaceId: WS, tool: "node", runner: "npm", argv: ["run", "test"], durationSeconds: 240 };
    for (let n = 0; n < 5; n += 1) {
      expect((await handleReport({ actor: ACTOR, companyId: COMPANY, body }, t.host)).status).toBe(200);
    }
    const limited = await handleReport({ actor: ACTOR, companyId: COMPANY, body }, t.host);
    expect(limited.status).toBe(429);
  });
});
