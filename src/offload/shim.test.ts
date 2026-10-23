import { describe, expect, it, vi } from "vitest";
import type { HttpResult } from "./client.js";
import { shimMain, type ShimDeps } from "./shim-main.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const SHIM = "/opt/boat-offload/bin/boat-offload-cargo";
const REAL_CARGO = "/usr/local/cargo/bin/cargo";

function setup(env: Record<string, string | undefined> = {}) {
  const clock = { t: 1_000_000 };
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const deps: ShimDeps = {
    env: {
      PATH: "/opt/boat-offload/bin:/usr/local/cargo/bin:/usr/bin",
      PAPERCLIP_WORKSPACE_ID: WS,
      ...env,
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
    readToolchains: () => ["stable", "1.88.0"],
    spawn: vi.fn(async () => ({ code: 0 as number | null, signal: null as string | null })),
  };
  return { deps, out, err, clock, stdoutText: () => Buffer.concat(out).toString(), stderrText: () => Buffer.concat(err).toString() };
}

function completed(exitCode = 0) {
  return {
    version: 1,
    commandId: CMD,
    state: "completed",
    remoteStarted: true,
    fallbackSafe: false,
    events: [],
    nextCursor: 0,
    result: { exitCode, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null },
    terminalError: null,
  };
}

describe("passthrough (invoked as cargo)", () => {
  const asCargo = "/opt/boat-offload/bin/cargo";

  it("runs local with no broker calls when BOAT_OFFLOAD is unset", async () => {
    const t = setup();
    const exit = await shimMain(asCargo, ["test"], t.deps);
    expect(exit).toBe(0);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    expect(t.deps.http.post).not.toHaveBeenCalled();
  });

  it("treats BOAT_OFFLOAD=0 and other values as off", async () => {
    for (const value of ["0", "yes", "true", "2"]) {
      const t = setup({ BOAT_OFFLOAD: "1" });
      t.deps.env.BOAT_OFFLOAD = value;
      await shimMain(asCargo, ["test"], t.deps);
      expect(t.deps.http.post).not.toHaveBeenCalled();
      expect(t.deps.spawn).toHaveBeenCalledTimes(1);
    }
  });

  it("re-enters directly when the shim is already active (recursion guard)", async () => {
    const t = setup({ BOAT_OFFLOAD: "1", BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
    await shimMain(asCargo, ["test"], t.deps);
    expect(t.deps.http.post).not.toHaveBeenCalled();
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps fmt local without a broker call", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    await shimMain(asCargo, ["fmt", "--check"], t.deps);
    expect(t.deps.http.post).not.toHaveBeenCalled();
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("stays local without a workspace binding", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    delete t.deps.env.PAPERCLIP_WORKSPACE_ID;
    await shimMain(asCargo, ["test"], t.deps);
    expect(t.deps.http.post).not.toHaveBeenCalled();
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("dry-runs then submits an eligible command", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    const posts: { path: string; body: unknown }[] = [];
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: unknown) => {
      posts.push({ path, body });
      if ((body as { dryRun?: boolean }).dryRun === true) {
        return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible", profileId: "rust-public-1" } };
      }
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    (t.deps.http.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, status: 200, json: completed(0) }));
    const exit = await shimMain(asCargo, ["test", "--locked"], t.deps);
    expect(exit).toBe(0);
    expect(posts.filter((p) => (p.body as { dryRun?: boolean }).dryRun === true).length).toBe(1);
    expect(posts.filter((p) => (p.body as { dryRun?: boolean }).dryRun === false).length).toBe(1);
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });

  it("runs local when the server classifies local, with no submit", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => (
      { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "needs-db", profileId: "rust-public-1" } }
    ));
    await shimMain(asCargo, ["test"], t.deps);
    expect(t.deps.http.post).toHaveBeenCalledTimes(1);
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("removes the shim from PATH and marks re-entry on local spawn", async () => {
    const t = setup();
    await shimMain(asCargo, ["test"], t.deps);
    const [, , env] = (t.deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], Record<string, string>];
    expect(env.PATH).toBe("/usr/local/cargo/bin:/usr/bin");
    expect(env.BOAT_OFFLOAD_SHIM_ACTIVE).toBe("1");
  });

  it("exits 127 when no real cargo exists", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    t.deps.findExecutable = () => null;
    const exit = await shimMain(asCargo, ["test"], t.deps);
    expect(exit).toBe(127);
    expect(t.stderrText()).toMatch(/cargo/);
  });

  it("maps a local signal to 128+N", async () => {
    const t = setup();
    (t.deps.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({ code: null, signal: "SIGTERM" });
    expect(await shimMain(asCargo, ["test"], t.deps)).toBe(143);
  });

  it("keeps an unknown toolchain local when discovery fails", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    t.deps.readToolchains = () => {
      throw new Error("no rustup");
    };
    await shimMain(asCargo, ["+nightly-2026-01-01", "build"], t.deps);
    expect(t.deps.http.post).not.toHaveBeenCalled();
    expect(t.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("still consults the server for a bare command when discovery fails", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    t.deps.readToolchains = () => {
      throw new Error("no rustup");
    };
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => (
      { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "x", profileId: "p" } }
    ));
    await shimMain(asCargo, ["test"], t.deps);
    expect(t.deps.http.post).toHaveBeenCalledTimes(1);
  });
});

describe("diagnostic (invoked as boat-offload-cargo)", () => {
  it("--help prints usage with no network call", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    const exit = await shimMain(SHIM, ["--help"], t.deps);
    expect(exit).toBe(0);
    expect(t.stdoutText()).toMatch(/boat-offload-cargo/);
    expect(t.stdoutText()).toMatch(/--dry-run/);
    expect(t.deps.http.post).not.toHaveBeenCalled();
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });

  it("--dry-run classifies without submitting or spawning", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => (
      { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible", profileId: "rust-public-1" } }
    ));
    const exit = await shimMain(SHIM, ["--dry-run", "--", "test"], t.deps);
    expect(exit).toBe(0);
    expect(t.stdoutText()).toMatch(/remote_candidate/);
    expect(t.deps.http.post).toHaveBeenCalledTimes(1);
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });

  it("--dry-run --json emits the versioned envelope", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async () => (
      { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "fmt", profileId: "rust-public-1" } }
    ));
    await shimMain(SHIM, ["--dry-run", "--json", "--", "fmt"], t.deps);
    expect(JSON.parse(t.stdoutText())).toMatchObject({ version: 1, commandId: CMD, mode: "local", profileId: "rust-public-1" });
  });

  it("diagnostic run without --json behaves like passthrough", async () => {
    const t = setup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: unknown) => {
      if ((body as { dryRun?: boolean }).dryRun === true) {
        return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible", profileId: "rust-public-1" } };
      }
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    (t.deps.http.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, status: 200, json: completed(0) }));
    const exit = await shimMain(SHIM, ["--", "test"], t.deps);
    expect(exit).toBe(0);
    expect(t.stderrText()).toBe("");
  });

  it("diagnostic --json run emits the result envelope on stderr", async () => {
    const t = setup();
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: unknown) => {
      if ((body as { dryRun?: boolean }).dryRun === true) {
        return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible", profileId: "rust-public-1" } };
      }
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    (t.deps.http.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, status: 200, json: completed(0) }));
    await shimMain(SHIM, ["--json", "--", "test"], t.deps);
    expect(JSON.parse(t.stderrText())).toMatchObject({ version: 1, commandId: CMD, mode: "remote", exitCode: 0 });
  });

  it("diagnostic dry-run without a workspace reports local with no broker call", async () => {
    const t = setup({ BOAT_OFFLOAD: "1" });
    delete t.deps.env.PAPERCLIP_WORKSPACE_ID;
    const exit = await shimMain(SHIM, ["--dry-run", "--", "test"], t.deps);
    expect(exit).toBe(0);
    expect(t.stdoutText()).toMatch(/local/);
    expect(t.deps.http.post).not.toHaveBeenCalled();
  });

  it("flags without -- are a usage error", async () => {
    const t = setup();
    expect(await shimMain(SHIM, ["--dry-run", "test"], t.deps)).toBe(64);
    expect(t.deps.http.post).not.toHaveBeenCalled();
  });

  it("clamps queue and command timeouts from the environment", async () => {
    const t = setup({ BOAT_OFFLOAD: "1", BOAT_OFFLOAD_QUEUE_TIMEOUT_MS: "99999", BOAT_OFFLOAD_TIMEOUT_MS: "9999999" });
    let sent: unknown = null;
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: unknown) => {
      sent = body;
      return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "x", profileId: "p" } };
    });
    await shimMain(SHIM, ["--dry-run", "--", "test"], t.deps);
    expect(sent).toMatchObject({ queueTimeoutMs: 30000, timeoutMs: 1800000 });
  });

  it("falls back to defaults on invalid timeout values", async () => {
    const t = setup({ BOAT_OFFLOAD: "1", BOAT_OFFLOAD_QUEUE_TIMEOUT_MS: "soon", BOAT_OFFLOAD_TIMEOUT_MS: "-5" });
    let sent: unknown = null;
    (t.deps.http.post as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, body: unknown) => {
      sent = body;
      return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "x", profileId: "p" } };
    });
    await shimMain(SHIM, ["--dry-run", "--", "test"], t.deps);
    expect(sent).toMatchObject({ queueTimeoutMs: 30000, timeoutMs: 1200000 });
  });
});
