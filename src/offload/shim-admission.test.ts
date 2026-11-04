import { describe, expect, it, vi } from "vitest";
import type { HttpResult } from "./client.js";
import { shimMain, type ShimDeps } from "./shim-main.js";

const PIN = "11111111-2222-4333-8444-555555555555";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const AS_CARGO = "/opt/boat-offload/bin/cargo";
const DIAG = "/opt/boat-offload/bin/boat-offload-cargo";

function setup(env: Record<string, string | undefined> = {}) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const randomId = vi.fn(() => "99999999-9999-4999-8999-999999999999");
  const post = vi.fn(async (_p: string, _b?: unknown): Promise<HttpResult> => ({ ok: true, status: 500, json: {} }));
  const get = vi.fn(async (_p: string): Promise<HttpResult> => ({ ok: true, status: 400, json: { code: "OFFLOAD_INVALID_REQUEST", detail: "unknown commandId", commandId: PIN } }));
  let now = 1_000_000;
  const spawn = vi.fn(async () => ({ code: 0 as number | null, signal: null as string | null }));
  const deps: ShimDeps = {
    env: {
      PATH: "/opt/boat-offload/bin:/usr/local/cargo/bin:/usr/bin",
      PAPERCLIP_WORKSPACE_ID: WS,
      PAPERCLIP_WORKSPACE_CWD: "/work/repo",
      BOAT_OFFLOAD: "1",
      BOAT_OFFLOAD_COMMAND_ID: PIN,
      ...env,
    },
    http: { post, get },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    stdout: (b) => out.push(Buffer.from(b)),
    stderr: (b) => err.push(Buffer.from(b)),
    onSignal: () => {},
    randomId,
    findExecutable: (dir, name) => (dir !== "/opt/boat-offload/bin" && name === "cargo" ? "/usr/local/cargo/bin/cargo" : null),
    cwd: () => "/work/repo",
    canonicalDir: (p) => p,
    readToolchains: () => ["stable"],
    spawn,
  };
  return { deps, post, get, spawn, randomId, stdout: () => Buffer.concat(out).toString(), stderr: () => Buffer.concat(err).toString() };
}

function view(state: string, extra: Record<string, unknown> = {}) {
  return { version: 1, commandId: PIN, state, remoteStarted: false, fallbackSafe: false, events: [], nextCursor: 0, result: null, terminalError: null, ...extra };
}
const completed = view("completed", {
  remoteStarted: true,
  result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null },
});
const bodyOf = (post: ReturnType<typeof setup>["post"], i = 0) => post.mock.calls[i]![1] as { commandId: string; dryRun: boolean };

describe("pinned command mode", () => {
  it("reuses the selector across two invocations that read existing receipts (flags off / expired grant)", async () => {
    const a = setup();
    const b = setup();
    for (const t of [a, b]) {
      t.post.mockResolvedValue({ ok: true, status: 200, json: completed });
      expect(await shimMain(AS_CARGO, ["test", "--locked"], t.deps)).toBe(0);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.randomId).not.toHaveBeenCalled();
      expect(t.post).toHaveBeenCalledTimes(1);
      expect(bodyOf(t.post).commandId).toBe(PIN);
      expect(bodyOf(t.post).dryRun).toBe(false);
    }
  });

  it("goes straight to exec without a prefilter or dry-run, even for syntactically local argv", async () => {
    const t = setup();
    t.post.mockResolvedValue({ ok: true, status: 200, json: completed });
    expect(await shimMain(AS_CARGO, ["--version"], t.deps)).toBe(0);
    expect(t.post.mock.calls.map((c) => (c[1] as { dryRun: boolean }).dryRun)).toEqual([false]);
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("refuses local fallback on a flags-off refusal (75) and keeps auth refusals at 77", async () => {
    const cases: Array<{ status: number; json: unknown; exit: number; refused: boolean }> = [
      { status: 503, json: { code: "OFFLOAD_UNAVAILABLE", detail: "flags off", remoteStarted: false, fallbackSafe: true }, exit: 75, refused: true },
      { status: 403, json: { code: "OFFLOAD_FORBIDDEN", detail: "grant expired", remoteStarted: false, fallbackSafe: true }, exit: 77, refused: false },
    ];
    for (const c of cases) {
      const t = setup();
      t.post.mockResolvedValue({ ok: true, status: c.status, json: c.json });
      expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(c.exit);
      expect(t.stderr().includes("local fallback refused")).toBe(c.refused);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(bodyOf(t.post).commandId).toBe(PIN);
    }
  });

  it("exits 75 with stderr (no spawn) on a never-started receipt", async () => {
    const t = setup();
    t.post.mockResolvedValue({ ok: true, status: 200, json: view("not_started", { fallbackSafe: true, fallbackReason: "pool down" }) });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(75);
    expect(t.stderr()).toContain("local fallback refused");
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("recovers the original receipt with newly present local-only env and no second submit", async () => {
    for (const script of [AS_CARGO, DIAG]) {
      const t = setup();
      const args = script === DIAG ? ["--", "test"] : ["test"];
      let submitted = false;
      t.post.mockImplementation(async () => {
        submitted = true;
        return { ok: true, status: 202, json: {} };
      });
      t.get.mockImplementation(async () => submitted
        ? { ok: true, status: 200, json: completed }
        : { ok: true, status: 400, json: { code: "OFFLOAD_INVALID_REQUEST", detail: "unknown commandId", commandId: PIN } });
      expect(await shimMain(script, args, t.deps)).toBe(0);
      expect(t.post).toHaveBeenCalledTimes(1);
      t.deps.env.DATABASE_URL = "postgres://local-only";
      expect(await shimMain(script, args, t.deps)).toBe(0);
      expect(t.get).toHaveBeenLastCalledWith(`/offload/commands/${PIN}?after=0`);
      expect(t.post).toHaveBeenCalledTimes(1);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.randomId).not.toHaveBeenCalled();
    }
  });

  it("resumes polling an existing pinned receipt before classifying local-only env", async () => {
    const t = setup({ DATABASE_URL: "postgres://local-only" });
    t.get.mockResolvedValueOnce({ ok: true, status: 200, json: view("running", { remoteStarted: true }) })
      .mockResolvedValue({ ok: true, status: 200, json: completed });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(0);
    expect(t.get).toHaveBeenCalledTimes(2);
    expect(t.post).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it.each([401, 403, 410, 500, 400, 200])("never submits or runs locally after an inconclusive/auth/expired receipt read (%i)", async (status) => {
    const t = setup();
    t.get.mockResolvedValue({ ok: true, status, json: {} });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(status === 401 || status === 403 ? 77 : 75);
    expect(t.post).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.randomId).not.toHaveBeenCalled();
  });

  it("refuses fresh client-side local classification after an authenticated missing-receipt read", async () => {
    for (const env of [{ DATABASE_URL: "postgres://x" }, { RUSTFLAGS: "-C opt-level=3" }]) {
      const t = setup(env);
      expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(75);
      expect(t.get).toHaveBeenCalledExactlyOnceWith(`/offload/commands/${PIN}?after=0`);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.post).not.toHaveBeenCalled();
      expect(t.stderr()).toContain("refused");
    }
  });

  it("exits 75 without spawning for opt-out, re-entry, missing workspace and cwd outside workspace", async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { BOAT_OFFLOAD: undefined },
      { BOAT_OFFLOAD_SHIM_ACTIVE: "1" },
      { PAPERCLIP_WORKSPACE_ID: undefined },
      { PAPERCLIP_WORKSPACE_CWD: undefined },
      { PAPERCLIP_WORKSPACE_CWD: "/elsewhere" },
    ];
    for (const env of cases) {
      const t = setup(env);
      expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(75);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.post).not.toHaveBeenCalled();
      expect(t.stderr()).toContain(PIN);
    }
  });

  it("does not spawn even when no real executable is on PATH, and refuses diagnostic re-entry", async () => {
    const t = setup();
    t.deps.findExecutable = () => null;
    t.post.mockResolvedValue({ ok: true, status: 200, json: completed });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(0);
    const r = setup({ BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
    expect(await shimMain(DIAG, ["--", "test"], r.deps)).toBe(75);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it("conflict and unknown responses never run locally", async () => {
    const conflict = setup();
    conflict.post.mockResolvedValue({ ok: true, status: 409, json: { code: "OFFLOAD_IDEMPOTENCY_CONFLICT", detail: "payload differs", remoteStarted: false, fallbackSafe: false } });
    expect(await shimMain(AS_CARGO, ["test"], conflict.deps)).toBe(64);
    expect(conflict.spawn).not.toHaveBeenCalled();
    const unknown = setup();
    unknown.post.mockResolvedValue({ ok: true, status: 200, json: view("unknown") });
    expect(await shimMain(AS_CARGO, ["test"], unknown.deps)).toBe(75);
    expect(unknown.spawn).not.toHaveBeenCalled();
  });

  it("diagnostic --dry-run keeps non-consuming discovery under the pinned ID", async () => {
    const t = setup();
    t.post.mockResolvedValue({ ok: true, status: 200, json: { mode: "remote", reason: "ok", profileId: "p" } });
    expect(await shimMain(DIAG, ["--dry-run", "--json", "--", "test"], t.deps)).toBe(0);
    expect(bodyOf(t.post).dryRun).toBe(true);
    expect(bodyOf(t.post).commandId).toBe(PIN);
    expect(t.stdout()).toContain(PIN);
    expect(t.randomId).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("pinned real diagnostic --json still reports the remote envelope on stderr", async () => {
    const t = setup();
    t.post.mockResolvedValue({ ok: true, status: 200, json: completed });
    expect(await shimMain(DIAG, ["--json", "--", "test"], t.deps)).toBe(0);
    expect(t.stderr()).toContain(`"commandId":"${PIN}","mode":"remote","exitCode":0`);
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("dry-run without workspace reports the pinned ID", async () => {
    const t = setup({ PAPERCLIP_WORKSPACE_ID: undefined });
    expect(await shimMain(DIAG, ["--dry-run", "--json", "--", "test"], t.deps)).toBe(0);
    expect(t.stdout()).toContain(PIN);
  });

  it("accepts an uppercase UUID, normalized to lowercase", async () => {
    const t = setup({ BOAT_OFFLOAD_COMMAND_ID: PIN.toUpperCase() });
    t.post.mockResolvedValue({ ok: true, status: 200, json: completed });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(0);
    expect(bodyOf(t.post).commandId).toBe(PIN);
  });
});

describe("malformed selector", () => {
  it.each(["", "not-a-uuid", `${PIN} `, `{${PIN}}`, PIN.replace(/-/g, ""), `${PIN}0`])("fails %j with 64 before spawn or network", async (bad) => {
    for (const script of [AS_CARGO, DIAG]) {
      const t = setup({ BOAT_OFFLOAD_COMMAND_ID: bad });
      expect(await shimMain(script, script === DIAG ? ["--", "test"] : ["test"], t.deps)).toBe(64);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.post).not.toHaveBeenCalled();
      expect(t.get).not.toHaveBeenCalled();
      expect(t.stderr()).toContain("BOAT_OFFLOAD_COMMAND_ID");
    }
  });
});

describe("unpinned legacy behavior", () => {
  it("still mints a random ID, runs local on opt-out, and falls back on never-started", async () => {
    const off = setup({ BOAT_OFFLOAD_COMMAND_ID: undefined, BOAT_OFFLOAD: undefined });
    expect(await shimMain(AS_CARGO, ["test"], off.deps)).toBe(0);
    expect(off.spawn).toHaveBeenCalledTimes(1);

    const t = setup({ BOAT_OFFLOAD_COMMAND_ID: undefined });
    t.post.mockImplementation(async (_p, body) => {
      const b = body as { dryRun: boolean; commandId: string };
      if (b.dryRun) return { ok: true, status: 200, json: { mode: "remote", reason: "ok", profileId: "p" } };
      return { ok: true, status: 200, json: { ...view("not_started", { fallbackSafe: true, fallbackReason: "x", commandId: b.commandId }) } };
    });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(0);
    expect(t.randomId).toHaveBeenCalled();
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.stderr()).toContain("running local");
  });

  it("unpinned localfallback on client env classification still runs local", async () => {
    const t = setup({ BOAT_OFFLOAD_COMMAND_ID: undefined, DATABASE_URL: "x" });
    t.post.mockResolvedValue({ ok: true, status: 200, json: { mode: "remote", reason: "ok", profileId: "p" } });
    expect(await shimMain(AS_CARGO, ["test"], t.deps)).toBe(0);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });
});
