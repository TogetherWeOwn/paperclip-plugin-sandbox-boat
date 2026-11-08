// Deterministic cancellation regressions for the shim entrypoint. Every await
// point is an explicit deferred; there are no sleeps, timers or real processes.

import { describe, expect, it, vi } from "vitest";
import type { HttpResult } from "./client.js";
import { CARGO_SHIM, NODE_SHIM, PYTHON_SHIM, shimMain, type ShimDeps, type SpawnResult, type ToolShim } from "./shim-main.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const SHIM_DIR = "/opt/boat-offload/bin";

type Sig = "SIGINT" | "SIGTERM";
const EXIT: Record<Sig, number> = { SIGINT: 130, SIGTERM: 143 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Case {
  name: string;
  tool: ToolShim;
  /** Installed name for passthrough, diagnostic binary name otherwise. */
  script: string;
  /** Args handed to shimMain (including `--` for diagnostics). */
  args: string[];
  durationReported: boolean;
}

const PASSTHROUGH: Case[] = [
  { name: "cargo passthrough", tool: CARGO_SHIM, script: `${SHIM_DIR}/cargo`, args: ["test", "--locked"], durationReported: false },
  { name: "node passthrough", tool: NODE_SHIM, script: `${SHIM_DIR}/npm`, args: ["run", "test"], durationReported: true },
  { name: "python passthrough", tool: PYTHON_SHIM, script: `${SHIM_DIR}/pytest`, args: ["tests/"], durationReported: true },
];

const DIAGNOSTIC: Case[] = [
  { name: "cargo diagnostic --json", tool: CARGO_SHIM, script: `${SHIM_DIR}/boat-offload-cargo`, args: ["--json", "--", "test", "--locked"], durationReported: false },
  { name: "node diagnostic --json", tool: NODE_SHIM, script: `${SHIM_DIR}/boat-offload-node`, args: ["--json", "--", "run", "test"], durationReported: true },
  { name: "python diagnostic --json", tool: PYTHON_SHIM, script: `${SHIM_DIR}/boat-offload-python`, args: ["--json", "--", "tests/"], durationReported: true },
];

const ALL = [...PASSTHROUGH, ...DIAGNOSTIC];
const DURATION = ALL.filter((c) => c.durationReported);

interface Harness {
  deps: ShimDeps;
  posts: Array<{ path: string; body: unknown }>;
  /** Delivers a signal to every registered handler, as a process-level listener set would. */
  emit: (signal: Sig) => void;
  spawn: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stderrText: () => string;
}

function harness(post: (path: string, body: unknown) => Promise<HttpResult>, spawnImpl?: () => Promise<SpawnResult>): Harness {
  const handlers: Array<(signal: Sig) => void> = [];
  const err: Buffer[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const kill = vi.fn();
  const postFn = vi.fn((path: string, body?: unknown) => {
    posts.push({ path, body });
    return post(path, body);
  });
  const spawn = vi.fn(async (_exe: string, _argv: string[], _env: Record<string, string>, options?: { onSpawn?: (k: (s: Sig) => void) => void }) => {
    options?.onSpawn?.(kill);
    return spawnImpl ? spawnImpl() : { code: 0, signal: null };
  });
  const deps: ShimDeps = {
    env: {
      PATH: `${SHIM_DIR}:/usr/local/bin:/usr/bin`,
      PAPERCLIP_WORKSPACE_ID: WS,
      PAPERCLIP_WORKSPACE_CWD: "/work/repo",
      BOAT_OFFLOAD: "1",
    },
    http: {
      post: postFn,
      // Pre-fix code may submit despite cancellation. Let it finish so the
      // regression fails by assertion, never an unbounded recovery loop.
      get: vi.fn(async (): Promise<HttpResult> => ({ ok: true, status: 200, json: {
        commandId: CMD, state: "completed", remoteStarted: true, fallbackSafe: false,
        events: [], nextCursor: 0,
        result: { exitCode: 0, signal: null, timedOut: false, cancelled: false,
          syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null }, usageRecordId: null },
      } })),
    },
    now: () => 1_000_000,
    sleep: async () => {},
    stdout: () => {},
    stderr: (b) => err.push(Buffer.from(b)),
    onSignal: (h) => {
      handlers.push(h);
    },
    randomId: () => CMD,
    findExecutable: (dir, name) => (dir !== SHIM_DIR ? `/usr/local/bin/${name}` : null),
    cwd: () => "/work/repo",
    canonicalDir: (p) => p,
    readToolchains: () => ["stable"],
    spawn: spawn as unknown as ShimDeps["spawn"],
  };
  return {
    deps,
    posts,
    emit: (signal) => handlers.forEach((h) => h(signal)),
    spawn,
    post: postFn,
    kill,
    stderrText: () => Buffer.concat(err).toString(),
  };
}

const classification = (mode: "local" | "remote_candidate"): HttpResult => ({
  ok: true,
  status: 200,
  json: { version: 1, commandId: CMD, mode, reason: mode === "local" ? "below duration gate" : "eligible", profileId: "profile-1" },
});

const isDryRun = (body: unknown) => (body as { dryRun?: boolean } | undefined)?.dryRun === true;

describe("signal during unresolved dry-run classification", () => {
  type Outcome = "remote_candidate" | "local" | "rejected";
  const outcomes: Outcome[] = ["remote_candidate", "local", "rejected"];

  for (const c of ALL) {
    for (const outcome of outcomes) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        it(`${c.name}: ${signal} then ${outcome} exits ${EXIT[signal]} with no spawn and no submit`, async () => {
          const classify = deferred<HttpResult>();
          const started = deferred();
          const h = harness((_path, body) => {
            if (isDryRun(body)) {
              started.resolve();
              return classify.promise;
            }
            return Promise.resolve({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } });
          });

          const result = shimMain(c.script, c.args, h.deps, c.tool);
          await started.promise;
          h.emit(signal);
          if (outcome === "rejected") classify.reject(new Error("broker unreachable"));
          else classify.resolve(classification(outcome));

          expect(await result).toBe(EXIT[signal]);
          expect(h.spawn).not.toHaveBeenCalled();
          expect(h.kill).not.toHaveBeenCalled();
          // Only the dry-run was issued: no real submit, no duration report.
          expect(h.posts.map((p) => p.path)).toEqual(["/offload/exec"]);
          expect(h.posts.every((p) => isDryRun(p.body))).toBe(true);
        });
      }
    }
  }

  it("keeps the first signal when a second arrives during classification", async () => {
    const classify = deferred<HttpResult>();
    const started = deferred();
    const h = harness(() => {
      started.resolve();
      return classify.promise;
    });
    const result = shimMain(`${SHIM_DIR}/npm`, ["run", "test"], h.deps, NODE_SHIM);
    await started.promise;
    h.emit("SIGINT");
    h.emit("SIGTERM");
    classify.resolve(classification("remote_candidate"));
    expect(await result).toBe(130);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("preserves the client contract: %s during a pending submit cancels the original command ID", async (signal) => {
    const submit = deferred<HttpResult>();
    const submitStarted = deferred();
    const h = harness((path, body) => {
      if (path.endsWith("/cancel")) return Promise.resolve({ ok: true, status: 200, json: {} });
      if (isDryRun(body)) return Promise.resolve(classification("remote_candidate"));
      submitStarted.resolve();
      return submit.promise;
    });
    const result = shimMain(`${SHIM_DIR}/cargo`, ["test", "--locked"], h.deps, CARGO_SHIM);
    await submitStarted.promise;
    h.emit(signal);
    submit.resolve({ ok: true, status: 202, json: { version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 } });
    expect(await result).toBe(EXIT[signal]);
    expect(h.posts.map((p) => p.path)).toEqual(["/offload/exec", "/offload/exec", `/offload/commands/${CMD}/cancel`]);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("signal while the duration report is pending after the child completed", () => {
  for (const c of DURATION) {
    it.each(["SIGINT", "SIGTERM"] as const)(`${c.name}: %s after a client-authorized local fallback overrides success`, async (signal) => {
      const report = deferred<HttpResult>();
      const reportStarted = deferred();
      const h = harness((path, body) => {
        if (path === "/offload/report") {
          reportStarted.resolve();
          return report.promise;
        }
        if (isDryRun(body)) return Promise.resolve(classification("remote_candidate"));
        return Promise.resolve({ ok: true, status: 503, json: {
          code: "OFFLOAD_UNAVAILABLE", detail: "never started", commandId: CMD,
          remoteStarted: false, fallbackSafe: true,
        } });
      });
      const result = shimMain(c.script, c.args, h.deps, c.tool);
      await reportStarted.promise;
      h.emit(signal);
      report.resolve({ ok: true, status: 200, json: { recorded: true } });
      expect(await result).toBe(EXIT[signal]);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(h.kill).not.toHaveBeenCalled();
      expect(h.posts.map((p) => p.path)).toEqual(["/offload/exec", "/offload/exec", "/offload/report"]);
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const childExit of [0, 23]) {
        for (const reportOutcome of ["resolved", "rejected"] as const) {
          it(`${c.name}: ${signal}, child exit ${childExit}, report ${reportOutcome} exits ${EXIT[signal]} without signalling the exited child or respawning`, async () => {
            const report = deferred<HttpResult>();
            const reportStarted = deferred();
            const h = harness(
              (path) => {
                if (path === "/offload/report") {
                  reportStarted.resolve();
                  return report.promise;
                }
                return Promise.resolve(classification("local"));
              },
              async () => ({ code: childExit, signal: null }),
            );

            const result = shimMain(c.script, c.args, h.deps, c.tool);
            await reportStarted.promise;
            expect(h.spawn).toHaveBeenCalledTimes(1);
            h.emit(signal);
            if (reportOutcome === "rejected") report.reject(new Error("report failed"));
            else report.resolve({ ok: true, status: 200, json: { version: 1, recorded: true } });

            expect(await result).toBe(EXIT[signal]);
            expect(h.kill).not.toHaveBeenCalled();
            expect(h.spawn).toHaveBeenCalledTimes(1);
            expect(h.posts.filter((p) => p.path === "/offload/report")).toHaveLength(1);
          });
        }
      }
    }

    it(`${c.name}: first signal wins when both arrive while the report is pending`, async () => {
      const report = deferred<HttpResult>();
      const reportStarted = deferred();
      const h = harness(
        (path) => {
          if (path === "/offload/report") {
            reportStarted.resolve();
            return report.promise;
          }
          return Promise.resolve(classification("local"));
        },
        async () => ({ code: 0, signal: null }),
      );
      const result = shimMain(c.script, c.args, h.deps, c.tool);
      await reportStarted.promise;
      h.emit("SIGTERM");
      h.emit("SIGINT");
      report.resolve({ ok: true, status: 200, json: { version: 1, recorded: true } });
      expect(await result).toBe(143);
      expect(h.kill).not.toHaveBeenCalled();
      expect(h.spawn).toHaveBeenCalledTimes(1);
    });

    for (const childExit of [0, 23]) {
      it.each(["resolved", "rejected"] as const)(`${c.name}: without a signal, a %s report keeps child exit ${childExit}`, async (outcome) => {
        const h = harness(
          (path) => (path === "/offload/report"
            ? outcome === "rejected" ? Promise.reject(new Error("report failed")) : Promise.resolve({ ok: true, status: 200, json: { recorded: true } })
            : Promise.resolve(classification("local"))),
          async () => ({ code: childExit, signal: null }),
        );
        expect(await shimMain(c.script, c.args, h.deps, c.tool)).toBe(childExit);
        expect(h.spawn).toHaveBeenCalledTimes(1);
        expect(h.kill).not.toHaveBeenCalled();
        expect(h.posts.filter((p) => p.path === "/offload/report")).toHaveLength(1);
      });
    }
  }
});
