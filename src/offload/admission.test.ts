import { describe, expect, it, vi } from "vitest";
import { createFakeContext } from "../test-support/harness.js";
import { ADMISSION_MAX_WINDOW_MS, OffloadAdmission, parseAdmissionPolicy, type AdmissionState } from "./admission.js";
import { OffloadBroker, TOMBSTONE_RETENTION_MS, type OffloadBackend, type OffloadOutputSink } from "./broker.js";
import { OFFLOAD_BOUNDS, type OffloadSubmitRequest } from "./protocol.js";
import { handleCancel, handleExec, handleHeartbeat, handleRead, V1_PROFILE, type OffloadRouteHost, type RouteActor } from "./routes.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-bccc-cccccccccccc";
const WS = "dddddddd-dddd-4ddd-bddd-dddddddddddd";
const CMD = "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee";
const OTHER = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const policy = () => ({ version: 1, companyId: COMPANY, agentId: AGENT, runId: RUN, executionWorkspaceId: WS,
  commandId: CMD, issuedAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString() });
const actor = (): RouteActor => ({ actorType: "agent", actorId: AGENT, agentId: AGENT, runId: RUN, authenticatedRunId: RUN });
const request = (extra: Partial<OffloadSubmitRequest> = {}): OffloadSubmitRequest => ({ version: 1, commandId: CMD,
  executionWorkspaceId: WS, cwdRelative: ".", argv: ["test", "--locked"], env: {}, queueTimeoutMs: 0, timeoutMs: 10_000, dryRun: false, ...extra });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const h = createFakeContext();
  let now = NOW;
  const config: Record<string, unknown> = { offloadExecutorEnabled: true, offloadAdmission: policy() };
  const insertJournal = h.ctx.state.create;
  const create = vi.spyOn(h.ctx.state, "create");
  const bind = vi.fn(async () => {});
  const workspace = vi.fn(async () => ({ repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null,
    path: "/fake/offload-source", cwd: "/fake/offload-source" }));
  const sinks: OffloadOutputSink[] = [];
  const start = vi.fn<OffloadBackend["start"]>((_command, sink) => {
    sinks.push(sink);
    return { done: new Promise<void>(() => {}), cancel: async () => ({ state: "not_started", remoteStarted: false, fallbackSafe: true, result: null }) };
  });
  const scope = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: COMPANY, namespace: "boat-offload", stateKey });
  const store = { create: (key: string, value: unknown) => insertJournal(scope(key), value),
    get: (key: string) => h.ctx.state.get(scope(key)), set: (key: string, value: unknown) => h.ctx.state.set(scope(key), value),
    delete: (key: string) => h.ctx.state.delete(scope(key)) };
  const host = (state: AdmissionState = h.ctx.state): OffloadRouteHost => ({
    admission: new OffloadAdmission(state, () => now, async () => config),
    broker: new OffloadBroker({ store, backend: { start }, now: () => now }), bindWorkspace: bind,
    workspaces: { get: workspace }, profile: V1_PROFILE,
  });
  const routeHost = host();
  const exec = (body = request(), who = actor(), companyId = COMPANY, via = routeHost) => handleExec({ actor: who, companyId, body }, via);
  const claimScope = { scopeKind: "company" as const, scopeId: COMPANY, namespace: "boat-offload-admission-v1", stateKey: RUN };
  return { h, config, create, bind, workspace, start, sinks, store, host, routeHost, exec, claimScope, advance: (ms: number) => { now += ms; } };
}

describe("strict operator policy", () => {
  it("accepts only the bounded versioned exact tuple", () => {
    expect(parseAdmissionPolicy(policy())).toEqual(policy());
    expect(parseAdmissionPolicy({ ...policy(), expiresAt: new Date(NOW - 1_000 + ADMISSION_MAX_WINDOW_MS).toISOString() })).not.toBeNull();
  });
  it.each([undefined, null, {}, [], "*", { ...policy(), version: 2 }, { ...policy(), runId: "*" },
    { ...policy(), companyId: OTHER.toUpperCase() }, { ...policy(), agentId: "" }, { ...policy(), commandId: [CMD] },
    { ...policy(), issuedAt: "2026-11-04T12:00:00Z" }, { ...policy(), issuedAt: "2026-02-30T12:00:00.000Z" },
    { ...policy(), issuedAt: policy().expiresAt }, { ...policy(), expiresAt: new Date(NOW + ADMISSION_MAX_WINDOW_MS).toISOString() },
    { ...policy(), extra: true }, { ...policy(), executionWorkspaceId: undefined }])("rejects malformed policy %#", (value) => {
    expect(parseAdmissionPolicy(value)).toBeNull();
  });
});

describe("new admission before binding", () => {
  it.each([false, true])("missing policy denies dryRun=%s without binding, journal or dispatch", async (dryRun) => {
    const t = setup();
    delete t.config.offloadAdmission;
    expect((await t.exec(request({ dryRun }))).status).toBe(403);
    expect(t.bind).not.toHaveBeenCalled();
    expect(t.workspace).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
    expect(t.h.state.size).toBe(0);
    expect(t.start).not.toHaveBeenCalled();
  });
  it.each([false, true])("older host without atomic create denies dryRun=%s, no speculative write", async (dryRun) => {
    const t = setup();
    const { create: _create, ...legacyState } = t.h.ctx.state;
    expect((await t.exec(request({ dryRun }), actor(), COMPANY, t.host(legacyState))).status).toBe(403);
    expect(t.bind).not.toHaveBeenCalled();
    expect(t.h.state.size).toBe(0);
  });
  it.each([
    { authenticatedRunId: null }, { authenticatedRunId: undefined }, { authenticatedRunId: "" },
    { authenticatedRunId: OTHER }, { runId: OTHER }, { agentId: OTHER }, { agentId: null }, { actorType: "user" as const },
  ])("rejects untrusted or wrong actor %# before binding", async (patch) => {
    const t = setup();
    for (const dryRun of [false, true]) expect((await t.exec(request({ dryRun }), { ...actor(), ...patch })).status).toBeGreaterThanOrEqual(400);
    expect(t.bind).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });
  it.each(["companyId", "agentId", "runId", "executionWorkspaceId", "commandId"])("pins policy %s", async (key) => {
    const t = setup();
    t.config.offloadAdmission = { ...policy(), [key]: OTHER };
    for (const dryRun of [false, true]) expect((await t.exec(request({ dryRun }))).status).toBe(403);
    expect(t.bind).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("rejects a cross-company request even with matching caller-selected metadata", async () => {
    const t = setup();
    expect((await t.exec(request(), actor(), OTHER)).status).toBe(403);
    expect(t.bind).not.toHaveBeenCalled();
  });
  it.each(["future", "expired", "disabled", "malformed"])("refuses %s grants", async (mode) => {
    const t = setup();
    if (mode === "future") t.config.offloadAdmission = { ...policy(), issuedAt: new Date(NOW + 1).toISOString() };
    if (mode === "expired") t.advance(60_000);
    if (mode === "disabled") t.config.offloadExecutorEnabled = false;
    if (mode === "malformed") t.config.offloadAdmission = [];
    expect((await t.exec()).status).toBe(403);
    expect(t.bind).not.toHaveBeenCalled();
  });
  it("dry-run is read-only and neither binds nor consumes", async () => {
    const t = setup();
    const result = await t.exec(request({ dryRun: true }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ mode: "remote_candidate", commandId: CMD });
    expect(t.bind).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
    expect(t.h.state.size).toBe(0);
    expect((await t.exec()).status).toBe(202);
    expect(t.bind).toHaveBeenCalledTimes(1);
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  it("revalidates current config after binding and before consumption", async () => {
    const t = setup();
    t.bind.mockImplementation(async () => { t.config.offloadAdmission = null; });
    expect((await t.exec()).status).toBe(403);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("keeps profile and workload gates ahead of consumption", async () => {
    const t = setup();
    t.routeHost.settings = { offloadProfiles: [] };
    expect((await t.exec()).status).toBe(503);
    expect(t.bind).not.toHaveBeenCalled();
    t.routeHost.settings = undefined;
    expect((await t.exec(request({ argv: ["fmt"] }))).status).toBe(503);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("only the exact admitted actor can journal a local refusal under the pinned ID", async () => {
    const t = setup();
    const local = request({ argv: ["fmt"] });
    for (const who of [
      { ...actor(), runId: OTHER, authenticatedRunId: OTHER },
      { ...actor(), agentId: OTHER, actorId: OTHER },
      { ...actor(), authenticatedRunId: undefined },
    ]) expect((await t.exec(local, who)).status).toBe(403);
    expect(t.h.state.size).toBe(0);
    expect(t.bind).not.toHaveBeenCalled();

    expect((await t.exec(local)).status).toBe(503);
    expect(await t.h.ctx.state.get(t.claimScope)).toBeNull();
    // A deterministic never-started receipt fixes this ID's payload even
    // without consuming a dispatch slot. It is not a reusable grant selector.
    expect((await t.exec(local)).status).toBe(200);
    expect((await t.exec()).status).toBe(409);
    expect(t.start).not.toHaveBeenCalled();
  });
  it("config/state read failure fails closed", async () => {
    const t = setup();
    vi.spyOn(t.h.ctx.state, "get").mockRejectedValue(new Error("storage offline"));
    expect(await t.routeHost.admission!.check(COMPANY, actor(), request())).toMatchObject({ status: 403 });
    const admission = new OffloadAdmission(t.h.ctx.state, () => NOW, async () => { throw new Error("config offline"); });
    expect(await admission.check(COMPANY, actor(), request())).toMatchObject({ status: 403 });
  });
});

describe("durable one-command consumption", () => {
  it("commits the claim before backend start, pins canonical digest and never uses set/delete for it", async () => {
    const t = setup();
    t.start.mockImplementation((_cmd, sink) => {
      expect([...t.h.state.keys()].some((key) => key.includes("boat-offload-admission-v1"))).toBe(true);
      t.sinks.push(sink);
      return { done: new Promise<void>(() => {}), cancel: async () => {} };
    });
    expect((await t.exec()).status).toBe(202);
    expect(await t.h.ctx.state.get(t.claimScope)).toMatchObject({ version: 1, companyId: COMPANY, agentId: AGENT, runId: RUN,
      executionWorkspaceId: WS, commandId: CMD, digest: expect.stringMatching(/^[0-9a-f]{64}$/), consumedAt: NOW });
    expect(t.start).toHaveBeenCalledTimes(1);
  });
  it("same-id same-digest retries are receipts even with flags off or no trusted run field", async () => {
    const t = setup();
    const first = request({ env: { RUST_BACKTRACE: "0", CARGO_TERM_COLOR: "never" } });
    expect((await t.exec(first)).status).toBe(202);
    t.config.offloadExecutorEnabled = false;
    t.config.offloadAdmission = null;
    const retry = request({ env: { CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "0" } });
    expect((await t.exec(retry, { ...actor(), authenticatedRunId: null })).status).toBe(200);
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.bind).toHaveBeenCalledTimes(1);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect((await t.exec(request({ dryRun: true }))).status).toBe(403);
    expect((await t.exec(request({ argv: ["build"] }))).body).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
  });
  it("rejects a different id after policy replacement, restart and original expiry", async () => {
    const t = setup();
    await t.exec();
    t.advance(61_000);
    t.config.offloadAdmission = { ...policy(), commandId: OTHER, issuedAt: new Date(NOW + 60_000).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString() };
    expect((await t.exec(request({ commandId: OTHER }), actor(), COMPANY, t.host())).body).toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN", fallbackSafe: false });
    expect(t.start).toHaveBeenCalledTimes(1);
    expect((await t.exec(request({ commandId: OTHER, dryRun: true }))).status).toBe(409);
  });
  it("allows exactly one winner across independent worker objects", async () => {
    const t = setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => t.exec(request(), actor(), COMPANY, t.host())));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.every((r) => [200, 202, 409].includes(r.status))).toBe(true);
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.create.mock.results.filter((r) => r.type === "return")).not.toHaveLength(0);
  });
  it("concurrent different UUIDs from replaced grants collide on company+run, not command", async () => {
    const t = setup();
    const a = new OffloadAdmission(t.h.ctx.state, () => NOW, async () => ({ offloadExecutorEnabled: true, offloadAdmission: policy() }));
    const b = new OffloadAdmission(t.h.ctx.state, () => NOW, async () => ({ offloadExecutorEnabled: true, offloadAdmission: { ...policy(), commandId: OTHER } }));
    const principal = { companyId: COMPANY, runId: RUN, cardId: "", repoId: "public", profileId: "rust-public-1" };
    const results = await Promise.all([a.consume(COMPANY, actor(), request(), principal), b.consume(COMPANY, actor(), request({ commandId: OTHER }), principal)]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.status === 409)).toHaveLength(1);
    expect([...t.h.state.keys()]).toHaveLength(1);
  });
  it.each([false, "true", undefined])("non-true create result %s grants no dispatch", async (value) => {
    const t = setup();
    t.create.mockResolvedValue(value as boolean);
    expect((await t.exec()).status).toBe(409);
    expect(t.start).not.toHaveBeenCalled();
  });
  it.each([false, true])("lost/error acknowledgement after committed=%s never dispatches", async (committed) => {
    const t = setup();
    t.create.mockRestore();
    const original = t.h.ctx.state.create;
    const create = vi.spyOn(t.h.ctx.state, "create").mockImplementation(async (scope, value) => {
      if (committed) await original(scope, value);
      throw new Error("lost acknowledgement");
    });
    expect((await t.exec()).body).toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN", fallbackSafe: false });
    expect(t.start).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await t.h.ctx.state.get(t.claimScope)).toEqual(committed ? expect.objectContaining({ commandId: CMD }) : null);
  });
  it.each(["offload.retention", `offload.cmd.${CMD}`, `offload.run.${RUN}.count`])("journal failure at %s leaves the slot permanently spent", async (failKey) => {
    const t = setup();
    const original = t.store.set;
    t.store.set = async (key, value) => { if (key === failKey) throw new Error("write failed"); await original(key, value); };
    const originalCreate = t.store.create;
    t.store.create = async (key, value) => { if (key === failKey) throw new Error("write failed"); return originalCreate(key, value); };
    // The broker captures the store object, so this tests every intent stage.
    await expect(t.exec()).rejects.toThrow("write failed");
    expect(t.start).not.toHaveBeenCalled();
    expect(await t.h.ctx.state.get(t.claimScope)).not.toBeNull();
    // Model recovery with no ordinary journal: a claim alone is never replay authority.
    for (const key of [...t.h.state.keys()]) if (!key.includes("boat-offload-admission-v1")) t.h.state.delete(key);
    expect((await t.exec(request(), actor(), COMPANY, t.host())).body).toMatchObject({ code: "OFFLOAD_EXECUTION_UNKNOWN", fallbackSafe: false });
    expect(t.start).not.toHaveBeenCalled();
  });
  it("completion, cancellation and both journal retention horizons never clear the permanent claim", async () => {
    const t = setup();
    await t.exec();
    t.sinks[0]!.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    await tick();
    const auth = { actor: actor(), companyId: COMPANY, params: { commandId: CMD } };
    expect((await handleCancel({ ...auth, body: {} }, t.routeHost)).status).toBe(200);
    t.advance(OFFLOAD_BOUNDS.resultRetentionMs + 1);
    await t.routeHost.broker.collectGarbage();
    t.advance(TOMBSTONE_RETENTION_MS + 1);
    await t.routeHost.broker.collectGarbage();
    expect(await t.h.ctx.state.get(t.claimScope)).not.toBeNull();
    t.config.offloadAdmission = { ...policy(), commandId: OTHER, issuedAt: new Date(NOW + OFFLOAD_BOUNDS.resultRetentionMs + TOMBSTONE_RETENTION_MS).toISOString(),
      expiresAt: new Date(NOW + OFFLOAD_BOUNDS.resultRetentionMs + TOMBSTONE_RETENTION_MS + 60_000).toISOString() };
    expect((await t.exec(request({ commandId: OTHER }), actor(), COMPANY, t.host())).status).toBe(409);
    expect(t.start).toHaveBeenCalledTimes(1);
  });
  it("read/heartbeat/cancel and restarted known-submit reconciliation keep legacy authorization when policy is gone", async () => {
    const t = setup();
    await t.exec();
    t.config.offloadAdmission = null;
    t.config.offloadExecutorEnabled = false;
    const legacy = { ...actor(), authenticatedRunId: undefined };
    const auth = { actor: legacy, companyId: COMPANY, params: { commandId: CMD } };
    expect((await handleRead({ ...auth, query: {} }, t.routeHost)).status).toBe(200);
    expect((await handleHeartbeat(auth, t.routeHost)).status).toBe(200);
    expect((await handleCancel({ ...auth, body: {} }, t.routeHost)).status).toBe(200);
    expect((await t.exec(request(), legacy, COMPANY, t.host())).status).toBe(200);
    const bad = { ...auth, actor: { ...legacy, runId: OTHER } };
    expect((await handleRead({ ...bad, query: {} }, t.routeHost)).status).toBe(403);
    expect(t.start).toHaveBeenCalledTimes(1);
  });
  it.each(["admission", "refusal"])("atomic journal intent preserves the %s winner against a racing incompatible payload", async (winner) => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const inserting = new Promise<void>((resolve) => { reached = resolve; });
    const slowStore = { ...t.store, create: async (key: string, value: unknown) => { reached(); await gate; return t.store.create(key, value); } };
    const slow = new OffloadBroker({ store: slowStore, backend: { start: t.start }, now: () => NOW });
    const other = t.host();
    const principal = { companyId: COMPANY, runId: RUN, cardId: "", repoId: "repo:https://github.com/example/public", profileId: V1_PROFILE.id };
    const refusal = () => (winner === "admission" ? slow : other.broker).recordRefusal(request({ argv: ["fmt"] }), principal, "local classification");
    const admit = () => t.exec(request(), actor(), COMPANY, winner === "refusal" ? { ...t.routeHost, broker: slow } : t.routeHost);
    const pending = winner === "admission" ? refusal() : admit();
    await inserting;
    const first = await (winner === "admission" ? admit() : refusal());
    expect(first?.status ?? null).toBe(winner === "admission" ? 202 : null);
    release();
    expect((await pending)?.status).toBe(409);
    expect(t.start).toHaveBeenCalledTimes(winner === "admission" ? 1 : 0);
    if (winner === "admission") expect((await t.routeHost.broker.read(CMD, principal, 0)).body).toMatchObject({ fallbackSafe: false });
  });
  it("snapshots actor and execution fields before asynchronous binding", async () => {
    const t = setup();
    const body = request();
    const who = actor();
    t.bind.mockImplementation(async () => { body.argv[0] = "build"; body.env.RUST_BACKTRACE = "1"; who.authenticatedRunId = OTHER; });
    expect((await t.exec(body, who)).status).toBe(202);
    expect(t.start.mock.calls[0]![0]).toMatchObject({ argv: ["test", "--locked"], env: {}, runId: RUN });
  });
  it("a malformed existing claim is spent, not overwritten", async () => {
    const t = setup();
    await t.h.ctx.state.set(t.claimScope, {});
    expect((await t.exec()).status).toBe(409);
    expect(t.create).not.toHaveBeenCalled();
    expect(await t.h.ctx.state.get(t.claimScope)).toEqual({});
  });
});
