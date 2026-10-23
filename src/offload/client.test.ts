import { describe, expect, it, vi } from "vitest";
import { runDryRun, runOffload, type BrokerHttp, type ClientDeps, type HttpResult, type ShimRequest } from "./client.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

function setup() {
  const clock = { t: 1_000_000 };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const sleeps: number[] = [];
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let signalHandler: ((s: "SIGINT" | "SIGTERM") => void) | null = null;
  const http: BrokerHttp & { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } = {
    post: vi.fn(async (_path: string, _body?: unknown): Promise<HttpResult> => ({ ok: true, status: 500, json: {} })),
    get: vi.fn(async (_path: string): Promise<HttpResult> => ({ ok: true, status: 500, json: {} })),
  };
  const deps: ClientDeps = {
    http,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    stdout: (b: Uint8Array) => out.push(Buffer.from(b)),
    stderr: (b: Uint8Array) => err.push(Buffer.from(b)),
    onSignal: (h) => {
      signalHandler = h;
    },
    randomId: () => CMD,
    runLocal: vi.fn(async () => 0),
    reportStaged: vi.fn(),
    reportUnknown: vi.fn(),
  };
  const request: ShimRequest = {
    argv: ["test", "--locked"],
    cwdRelative: ".",
    executionWorkspaceId: WS,
    queueTimeoutMs: 30000,
    timeoutMs: 1200000,
    processEnv: { CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "1" },
  };
  return { clock, calls, sleeps, out, err, http, deps, request, fireSignal: (s: "SIGINT" | "SIGTERM") => signalHandler?.(s) };
}

function readView(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: CMD,
    state: "running",
    remoteStarted: true,
    fallbackSafe: false,
    events: [],
    nextCursor: 0,
    result: null,
    terminalError: null,
    ...over,
  };
}

function errorBody(code: string, over: Record<string, unknown> = {}) {
  return {
    type: "https://boat.offload/errors/v1",
    title: code,
    status: 503,
    code,
    detail: code,
    retryable: false,
    next_action: "x",
    commandId: CMD,
    remoteStarted: null,
    fallbackSafe: false,
    ...over,
  };
}

describe("submit and env", () => {
  it("sends only allowlisted env in the request", async () => {
    const t = setup();
    t.request.processEnv = {
      CARGO_TERM_COLOR: "never",
      RUST_BACKTRACE: "full",
      DATABASE_URL: "postgres://secret",
      GITHUB_TOKEN: "canary",
      RUST_LOG: "debug",
    };
    t.http.post.mockImplementation(async (path: string, body: unknown) => {
      t.calls.push({ method: "POST", path, body });
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    t.http.get.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: readView({ state: "completed", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }),
    }));
    await runOffload(t.request, t.deps);
    const submit = t.calls.find((c) => c.path === "/offload/exec")!;
    expect(submit.body).toMatchObject({ version: 1, commandId: CMD, argv: ["test", "--locked"], dryRun: false });
    expect((submit.body as { env: Record<string, string> }).env).toEqual({ CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "full" });
  });

  it("omits invalid enum env values instead of sending a 400", async () => {
    const t = setup();
    t.request.processEnv = { CARGO_TERM_COLOR: "sometimes" };
    let sent: unknown = null;
    t.http.post.mockImplementation(async (_p: string, body: unknown) => {
      sent = body;
      return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
    });
    t.http.get.mockImplementation(async () => ({ ok: true, status: 200, json: readView({ state: "not_started", remoteStarted: false, fallbackSafe: true }) }));
    await runOffload(t.request, t.deps);
    expect((sent as { env: Record<string, string> }).env).toEqual({});
  });

  it("stays local when RUSTFLAGS is set (profile cannot validate it yet)", async () => {
    const t = setup();
    t.request.processEnv = { RUSTFLAGS: "-C debuginfo=1" };
    const exit = await runOffload(t.request, t.deps);
    expect(exit).toBe(0);
    expect(t.deps.runLocal).toHaveBeenCalledTimes(1);
    expect(t.http.post).not.toHaveBeenCalled();
  });
});

describe("output and polling", () => {
  it("renders batches incrementally to the original descriptors", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
    const e1 = { seq: 0, stream: "stdout", dataBase64: Buffer.from("out1").toString("base64") };
    const e2 = { seq: 1, stream: "stderr", dataBase64: Buffer.from("err1").toString("base64") };
    t.http.get
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: readView({ events: [e1], nextCursor: 1 }) }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: readView({ events: [e2], nextCursor: 2 }) }))
      .mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: readView({ state: "completed", events: [], nextCursor: 2, result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }),
      }));
    const exit = await runOffload(t.request, t.deps);
    expect(exit).toBe(0);
    expect(Buffer.concat(t.out).toString()).toBe("out1");
    expect(Buffer.concat(t.err).toString()).toBe("err1");
  });

  it("heartbeats every 5 seconds during an active command", async () => {
    const t = setup();
    t.http.post.mockImplementation(async (path: string) => {
      t.calls.push({ method: "POST", path });
      if (path === "/offload/exec") return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
      return { ok: true, status: 200, json: readView({}) };
    });
    let reads = 0;
    t.http.get.mockImplementation(async () => {
      reads += 1;
      if (reads < 25) return { ok: true, status: 200, json: readView({}) };
      return {
        ok: true,
        status: 200,
        json: readView({ state: "completed", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }),
      };
    });
    await runOffload(t.request, t.deps);
    const beats = t.calls.filter((c) => c.path === `/offload/commands/${CMD}/heartbeat`);
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves a nonzero cargo exit and a remote signal", async () => {
    for (const [result, expected] of [
      [{ exitCode: 101, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null }, 101],
      [{ exitCode: 0, signal: 9, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null }, 137],
    ] as const) {
      const t = setup();
      t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
      t.http.get.mockImplementation(async () => ({ ok: true, status: 200, json: readView({ state: "completed", result }) }));
      expect(await runOffload(t.request, t.deps)).toBe(expected);
    }
  });
});

describe("cancel", () => {
  it("posts cancel on a local signal and exits 128+N", async () => {
    const t = setup();
    t.http.post.mockImplementation(async (path: string, body: unknown) => {
      t.calls.push({ method: "POST", path, body });
      if (path === "/offload/exec") return { ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } };
      return { ok: true, status: 200, json: readView({ state: "cancelled", result: { exitCode: 143, signal: 15, timedOut: false, cancelled: true, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }) };
    });
    t.http.get.mockImplementation(async () => {
      t.fireSignal("SIGTERM");
      return { ok: true, status: 200, json: readView({}) };
    });
    const exit = await runOffload(t.request, t.deps);
    expect(exit).toBe(143);
    expect(t.calls.some((c) => c.path === `/offload/commands/${CMD}/cancel`)).toBe(true);
  });
});

describe("fallback and errors", () => {
  it("falls back exactly once on a durable never-started receipt", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
    t.http.get.mockImplementation(async () => ({ ok: true, status: 200, json: readView({ state: "not_started", remoteStarted: false, fallbackSafe: true }) }));
    (t.deps.runLocal as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    const exit = await runOffload(t.request, t.deps);
    expect(exit).toBe(3);
    expect(t.deps.runLocal).toHaveBeenCalledTimes(1);
    expect(t.deps.runLocal).toHaveBeenCalledWith(["test", "--locked"]);
  });

  it("falls back on submit-time OFFLOAD_UNAVAILABLE with a never-started guarantee", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 503, json: errorBody("OFFLOAD_UNAVAILABLE", { remoteStarted: false, fallbackSafe: true }) }));
    await runOffload(t.request, t.deps);
    expect(t.deps.runLocal).toHaveBeenCalledTimes(1);
  });

  it("maps submit errors without replay: 64, 77, 75", async () => {
    for (const [status, code, expected] of [
      [400, "OFFLOAD_INVALID_REQUEST", 64],
      [409, "OFFLOAD_IDEMPOTENCY_CONFLICT", 64],
      [401, "OFFLOAD_UNAUTHORIZED", 77],
      [403, "OFFLOAD_FORBIDDEN", 77],
      [410, "OFFLOAD_RESULT_EXPIRED", 75],
    ] as const) {
      const t = setup();
      t.http.post.mockImplementation(async () => ({ ok: true, status, json: errorBody(code) }));
      expect(await runOffload(t.request, t.deps)).toBe(expected);
      expect(t.deps.runLocal).not.toHaveBeenCalled();
    }
  });

  it("exits 74 on output-limit exhaustion after rendering retained output", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
    const e = { seq: 0, stream: "stdout", dataBase64: Buffer.from("kept").toString("base64") };
    t.http.get.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: readView({ state: "cancelled", events: [e], nextCursor: 1, terminalError: "OFFLOAD_OUTPUT_LIMIT", result: { exitCode: 143, signal: 15, timedOut: false, cancelled: true, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }),
    }));
    expect(await runOffload(t.request, t.deps)).toBe(74);
    expect(Buffer.concat(t.out).toString()).toBe("kept");
  });
});

describe("stage-first", () => {
  it("reports staged success explicitly and exits 74", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
    t.http.get.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: readView({ state: "completed", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "art-1" }, usageRecordId: null } }),
    }));
    expect(await runOffload(t.request, t.deps)).toBe(74);
    expect(t.deps.reportStaged).toHaveBeenCalledWith({ state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "art-1" });
  });

  it("preserves a nonzero exit while still exposing the staged artifact", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } }));
    t.http.get.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: readView({ state: "completed", result: { exitCode: 101, signal: null, timedOut: false, cancelled: false, syncBack: { state: "conflict", changedPaths: [], conflictPaths: ["x"], artifactId: "art-2" }, usageRecordId: null } }),
    }));
    expect(await runOffload(t.request, t.deps)).toBe(101);
    expect(t.deps.reportStaged).toHaveBeenCalledTimes(1);
  });
});

describe("ambiguous-submit recovery", () => {
  it("resumes normal handling on a running receipt within 10 s", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: false as const, error: "timeout" }));
    let reads = 0;
    t.http.get.mockImplementation(async () => {
      reads += 1;
      if (reads < 3) return { ok: true, status: 400, json: errorBody("OFFLOAD_INVALID_REQUEST") };
      return { ok: true, status: 200, json: readView({}) };
    });
    // After the running receipt, complete the command.
    t.http.get.mockImplementation(async () => {
      reads += 1;
      if (reads < 3) return { ok: true, status: 400, json: errorBody("OFFLOAD_INVALID_REQUEST") };
      if (reads === 3) return { ok: true, status: 200, json: readView({}) };
      return {
        ok: true,
        status: 200,
        json: readView({ state: "completed", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null } }),
      };
    });
    expect(await runOffload(t.request, t.deps)).toBe(0);
    expect(t.deps.runLocal).not.toHaveBeenCalled();
  });

  it("falls back when recovery proves never started", async () => {
    const t = setup();
    t.http.post.mockImplementation(async (path: string) => {
      if (path === "/offload/exec") return { ok: false as const, error: "timeout" };
      return { ok: true, status: 200, json: readView({ state: "not_started", remoteStarted: false, fallbackSafe: true }) };
    });
    t.http.get.mockImplementation(async () => ({ ok: true, status: 200, json: readView({ state: "not_started", remoteStarted: false, fallbackSafe: true }) }));
    await runOffload(t.request, t.deps);
    expect(t.deps.runLocal).toHaveBeenCalledTimes(1);
  });

  it("exits 75 with the original ID when still unresolved after 10 s", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: false as const, error: "timeout" }));
    t.http.get.mockImplementation(async () => ({ ok: false as const, error: "timeout" }));
    const exit = await runOffload(t.request, t.deps);
    expect(exit).toBe(75);
    expect(t.deps.runLocal).not.toHaveBeenCalled();
    expect(t.deps.reportUnknown).toHaveBeenCalledWith({ commandId: CMD });
    const slept = t.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeGreaterThanOrEqual(10_000);
    expect(slept).toBeLessThan(12_000);
  });
});

describe("dry run", () => {
  it("classifies without effects and never runs locally", async () => {
    const t = setup();
    let sent: unknown = null;
    t.http.post.mockImplementation(async (_p: string, body: unknown) => {
      sent = body;
      return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "remote_candidate", reason: "eligible", profileId: "rust-public-1" } };
    });
    const result = await runDryRun(t.request, t.deps);
    expect(result).toMatchObject({ mode: "remote_candidate", profileId: "rust-public-1" });
    expect((sent as { dryRun: boolean }).dryRun).toBe(true);
    expect(t.deps.runLocal).not.toHaveBeenCalled();
  });

  it("reports local without a broker call when RUSTFLAGS is set", async () => {
    const t = setup();
    t.request.processEnv = { RUSTFLAGS: "-C debuginfo=1" };
    const result = await runDryRun(t.request, t.deps);
    expect(result.mode).toBe("local");
    expect(t.http.post).not.toHaveBeenCalled();
  });

  it("throws a typed error when the broker rejects the dry run", async () => {
    const t = setup();
    t.http.post.mockImplementation(async () => ({ ok: true, status: 400, json: errorBody("OFFLOAD_INVALID_REQUEST") }));
    await expect(runDryRun(t.request, t.deps)).rejects.toThrow("OFFLOAD_INVALID_REQUEST");
  });
});
