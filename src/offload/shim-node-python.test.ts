import { describe, expect, it, vi } from "vitest";
import type { HttpResult } from "./client.js";
import { CARGO_SHIM, NODE_SHIM, PYTHON_SHIM, shimMain, type ShimDeps } from "./shim-main.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

function setup(tool: typeof NODE_SHIM, script: string, env: Record<string, string | undefined> = {}) {
  const clock = { t: 1_000_000 };
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const posted: unknown[] = [];
  const deps: ShimDeps = {
    env: {
      PATH: "/opt/boat-offload/bin:/usr/local/bin:/usr/bin",
      PAPERCLIP_WORKSPACE_ID: WS,
      PAPERCLIP_WORKSPACE_CWD: "/work/repo",
      BOAT_OFFLOAD: "1",
      ...env,
    },
    http: {
      post: vi.fn(async (urlPath: string, body: unknown): Promise<HttpResult> => {
        posted.push({ urlPath, body });
        if (urlPath === "/offload/exec") {
          return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "no duration history yet", profileId: "node-public-1" } };
        }
        return { ok: true, status: 200, json: { version: 1, recorded: true } };
      }),
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
    findExecutable: (dir: string, name: string) => (dir !== "/opt/boat-offload/bin" ? `/usr/local/bin/${name}` : null),
    cwd: () => "/work/repo",
    canonicalDir: (p: string) => p,
    readToolchains: () => [],
    spawn: vi.fn(async () => {
      clock.t += 240_000;
      return { code: 0 as number | null, signal: null as string | null };
    }),
  };
  return { deps, out, err, posted, stdoutText: () => Buffer.concat(out).toString(), stderrText: () => Buffer.concat(err).toString() };
}

describe("node shim passthrough (installed as npm)", () => {
  const asNpm = "/opt/boat-offload/bin/npm";

  it("runs local commands without broker calls and without reports", async () => {
    const t = setup(NODE_SHIM, asNpm);
    const exit = await shimMain(asNpm, ["run", "lint"], t.deps, NODE_SHIM);
    expect(exit).toBe(0);
    expect(t.posted).toHaveLength(0);
    expect(t.deps.spawn).toHaveBeenCalledOnce();
  });

  it("submits remote candidates with tool and runner, and reports the local fallback duration", async () => {
    const t = setup(NODE_SHIM, asNpm);
    const exit = await shimMain(asNpm, ["run", "test"], t.deps, NODE_SHIM);
    expect(exit).toBe(0);
    const dryRun = t.posted.find((p) => (p as { urlPath: string }).urlPath === "/offload/exec") as { body: Record<string, unknown> };
    expect(dryRun.body).toMatchObject({ tool: "node", runner: "npm", argv: ["run", "test"], env: {} });
    const report = t.posted.find((p) => (p as { urlPath: string }).urlPath === "/offload/report") as { body: Record<string, unknown> };
    expect(report.body).toMatchObject({ tool: "node", runner: "npm", argv: ["run", "test"], durationSeconds: 240 });
  });

  it("passes stdout/stderr/exit through on passthrough", async () => {
    const t = setup(NODE_SHIM, asNpm, { BOAT_OFFLOAD: "0" });
    const exit = await shimMain(asNpm, ["run", "test"], t.deps, NODE_SHIM);
    expect(exit).toBe(0);
    expect(t.posted).toHaveLength(0);
  });
});

describe("python shim passthrough (installed as pytest)", () => {
  const asPytest = "/opt/boat-offload/bin/pytest";

  it("reports the local fallback with the pytest runner", async () => {
    const t = setup(PYTHON_SHIM, asPytest);
    t.deps.http.post = vi.fn(async (urlPath: string, body: unknown): Promise<HttpResult> => {
      if (urlPath === "/offload/exec") {
        return { ok: true, status: 200, json: { version: 1, commandId: CMD, mode: "local", reason: "narrow", profileId: "python-public-1" } };
      }
      return { ok: true, status: 200, json: { version: 1, recorded: true } };
    });
    const exit = await shimMain(asPytest, ["tests/test_a.py::test_x"], t.deps, PYTHON_SHIM);
    expect(exit).toBe(0);
    // Prefilter-local (node id): no server round trip at all.
    expect(t.deps.http.post).not.toHaveBeenCalled();
  });
});

describe.each([CARGO_SHIM, NODE_SHIM, PYTHON_SHIM])("$tool shim re-entry", (tool) => {
  describe.each(tool.exeNames)("runner %s", (runner) => {
    const script = `/opt/boat-offload/bin/${tool.diagnosticName}`;
    const argv = ["test"];
    const diagnosticArgs = ["--runner", runner, "--", ...argv];

    describe.each(["diagnostic", "passthrough"])("%s", (mode) => {
      const entry = mode === "diagnostic" ? script : `/opt/boat-offload/bin/${runner}`;
      const args = mode === "diagnostic" ? diagnosticArgs : argv;

      it.each(["SIGINT", "SIGTERM"] as const)("forwards %s before and after onSpawn, and waits for child completion", async (signal) => {
        for (const beforeSpawn of [true, false]) {
          const t = setup(tool, entry, { BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
          let handler: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
          t.deps.onSignal = (h) => { handler = h; };
          const kill = vi.fn();
          let finish!: (result: { code: number; signal: null }) => void;
          const child = new Promise<{ code: number; signal: null }>((resolve) => { finish = resolve; });
          t.deps.spawn = vi.fn((_exe, _argv, _env, options) => {
            expect(handler).toBeTypeOf("function");
            if (beforeSpawn) handler!(signal);
            options?.onSpawn?.(kill);
            if (!beforeSpawn) handler!(signal);
            return child;
          });
          let settled = false;
          const result = shimMain(entry, args, t.deps, tool).then((exit) => {
            settled = true;
            return exit;
          });
          expect(kill).toHaveBeenCalledExactlyOnceWith(signal);
          await Promise.resolve();
          expect(settled).toBe(false);
          finish({ code: 0, signal: null });
          expect(await result).toBe(signal === "SIGINT" ? 130 : 143);
          expect(t.deps.spawn).toHaveBeenCalledExactlyOnceWith(`/usr/local/bin/${runner}`, argv,
            expect.objectContaining({ PATH: "/usr/local/bin:/usr/bin", BOAT_OFFLOAD_SHIM_ACTIVE: "1" }),
            expect.objectContaining({ onSpawn: expect.any(Function) }));
          handler!(signal);
          expect(kill).toHaveBeenCalledTimes(1);
          expect(t.deps.http.post).not.toHaveBeenCalled();
          expect(t.deps.http.get).not.toHaveBeenCalled();
        }
      });

      it("refuses a pinned command without spawning or calling the broker", async () => {
        const t = setup(tool, entry, { BOAT_OFFLOAD_SHIM_ACTIVE: "1", BOAT_OFFLOAD_COMMAND_ID: CMD });
        expect(await shimMain(entry, args, t.deps, tool)).toBe(75);
        expect(t.stderrText()).toContain("shim re-entry");
        expect(t.deps.spawn).not.toHaveBeenCalled();
        expect(t.deps.http.post).not.toHaveBeenCalled();
        expect(t.deps.http.get).not.toHaveBeenCalled();
      });
    });

    it.each([
      { code: 23, signal: null, expected: 23 },
      { code: null, signal: "SIGINT", expected: 130 },
      { code: null, signal: "SIGTERM", expected: 143 },
    ])("preserves child exit $expected without a parent signal", async ({ code, signal, expected }) => {
      const t = setup(tool, script, { BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
      t.deps.spawn = vi.fn(async () => ({ code, signal }));
      expect(await shimMain(script, diagnosticArgs, t.deps, tool)).toBe(expected);
      expect(t.deps.spawn).toHaveBeenCalledOnce();
      expect(t.deps.http.post).not.toHaveBeenCalled();
    });

    it("keeps diagnostic dry-run as discovery while active", async () => {
      const t = setup(tool, script, { BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
      expect(await shimMain(script, ["--dry-run", ...diagnosticArgs], t.deps, tool)).toBe(0);
      expect(t.deps.spawn).not.toHaveBeenCalled();
      expect(t.deps.http.post).toHaveBeenCalledExactlyOnceWith("/offload/exec", expect.objectContaining({
        dryRun: true, argv, ...(tool.tool === "cargo" ? {} : { tool: tool.tool, runner }),
      }));
      if (tool.tool === "cargo") {
        const { body } = t.posted[0] as { body: Record<string, unknown> };
        expect(body).not.toHaveProperty("tool");
        expect(body).not.toHaveProperty("runner");
      }
    });

    it("reports a missing real runner without spawning", async () => {
      const t = setup(tool, script, { BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
      t.deps.findExecutable = () => null;
      expect(await shimMain(script, diagnosticArgs, t.deps, tool)).toBe(127);
      expect(t.stderrText()).toContain(`no real ${runner} on PATH`);
      expect(t.deps.spawn).not.toHaveBeenCalled();
      expect(t.deps.http.post).not.toHaveBeenCalled();
    });
  });

  it("keeps help side-effect free while active", async () => {
    const script = `/opt/boat-offload/bin/${tool.diagnosticName}`;
    const t = setup(tool, script, { BOAT_OFFLOAD_SHIM_ACTIVE: "1" });
    expect(await shimMain(script, ["--help"], t.deps, tool)).toBe(0);
    expect(t.stdoutText()).toContain(tool.diagnosticName);
    expect(t.deps.spawn).not.toHaveBeenCalled();
    expect(t.deps.http.post).not.toHaveBeenCalled();
  });
});

describe("explicit uv extra producer", () => {
  it.each([undefined, "test"])("carries the opt-in %s with the actual cwd and empty env", async (extra) => {
    const t = setup(PYTHON_SHIM, "/opt/boat-offload/bin/pytest", { BOAT_OFFLOAD_UV_EXTRA: extra });
    t.deps.cwd = () => "/work/repo/tests/unit";
    await shimMain("/opt/boat-offload/bin/pytest", ["tests/"], t.deps, PYTHON_SHIM);
    const { body } = t.posted[0] as { body: Record<string, unknown> };
    expect(body).toMatchObject({ tool: "python", cwdRelative: "tests/unit", env: {} });
    const report = t.posted.find((p) => (p as { urlPath: string }).urlPath === "/offload/report") as { body: Record<string, unknown> };
    if (extra) {
      expect(body.depSelection).toEqual({ uvExtra: "test", cwdRelative: "tests/unit" });
      expect(report.body.depSelection).toEqual(body.depSelection);
    } else {
      expect(body).not.toHaveProperty("depSelection");
      expect(report.body).not.toHaveProperty("depSelection");
    }
  });

  it.each([CARGO_SHIM, NODE_SHIM, PYTHON_SHIM])("ignores inherited selection on local $tool passthrough paths", async (tool) => {
    const script = `/opt/boat-offload/bin/${tool.defaultRunner}`;
    for (const env of [
      { BOAT_OFFLOAD: undefined },
      { BOAT_OFFLOAD_SHIM_ACTIVE: "1" },
      { PAPERCLIP_WORKSPACE_ID: undefined },
      { PAPERCLIP_WORKSPACE_CWD: undefined },
      { PAPERCLIP_WORKSPACE_CWD: "/other/workspace" },
    ]) {
      const t = setup(tool, script, { BOAT_OFFLOAD_UV_EXTRA: "dev", ...env });
      t.deps.spawn = vi.fn(async () => ({ code: 23, signal: null }));
      expect(await shimMain(script, ["tests/"], t.deps, tool)).toBe(23);
      expect(t.posted).toHaveLength(0);
      expect(t.deps.spawn).toHaveBeenCalledOnce();
    }
  });

  it("allows a Python fallback child to re-enter a non-Python shim with inherited selection", async () => {
    const parent = setup(PYTHON_SHIM, "/opt/boat-offload/bin/pytest", { BOAT_OFFLOAD_UV_EXTRA: "test" });
    parent.deps.spawn = vi.fn(async (_exe, _argv, env) => {
      expect(env.BOAT_OFFLOAD_SHIM_ACTIVE).toBe("1");
      expect(env.BOAT_OFFLOAD_UV_EXTRA).toBe("test");
      const child = setup(CARGO_SHIM, "/opt/boat-offload/bin/cargo", env);
      const code = await shimMain("/opt/boat-offload/bin/cargo", ["build"], child.deps, CARGO_SHIM);
      expect(child.posted).toHaveLength(0);
      expect(child.deps.spawn).toHaveBeenCalledOnce();
      return { code, signal: null };
    });
    expect(await shimMain("/opt/boat-offload/bin/pytest", ["tests/"], parent.deps, PYTHON_SHIM)).toBe(0);
  });

  it("supports the explicit diagnostic flag without adding tool arguments", async () => {
    const t = setup(PYTHON_SHIM, "/opt/boat-offload/bin/boat-offload-python");
    expect(await shimMain("/opt/boat-offload/bin/boat-offload-python",
      ["--dry-run", "--uv-extra", "test", "--", "tests/"], t.deps, PYTHON_SHIM)).toBe(0);
    expect(t.posted[0]).toMatchObject({ body: { depSelection: { uvExtra: "test", cwdRelative: "." }, argv: ["tests/"], env: {} } });
  });

  it.each([
    { tool: PYTHON_SHIM, value: "dev" }, { tool: PYTHON_SHIM, value: "" },
    { tool: NODE_SHIM, value: "test" },
  ])("rejects invalid or wrong-tool opt-in before any effect: $value", async ({ tool, value }) => {
    const script = `/opt/boat-offload/bin/${tool.defaultRunner}`;
    const t = setup(tool, script, { BOAT_OFFLOAD_UV_EXTRA: value });
    expect(await shimMain(script, ["tests/"], t.deps, tool)).toBe(64);
    expect(t.posted).toHaveLength(0);
    expect(t.deps.spawn).not.toHaveBeenCalled();
  });
});

describe("diagnostic mode", () => {
  it("dry-runs with an explicit runner", async () => {
    const t = setup(NODE_SHIM, "/opt/boat-offload/bin/boat-offload-node");
    const exit = await shimMain("/opt/boat-offload/bin/boat-offload-node",
      ["--dry-run", "--runner", "pnpm", "--", "exec", "vitest", "run"], t.deps, NODE_SHIM);
    expect(exit).toBe(0);
    expect(t.stdoutText()).toContain("mode: local");
    const dryRun = (t.posted[0] as { body: Record<string, unknown> }).body;
    expect(dryRun).toMatchObject({ tool: "node", runner: "pnpm" });
  });

  it("rejects an unknown runner", async () => {
    const t = setup(NODE_SHIM, "/opt/boat-offload/bin/boat-offload-node");
    const exit = await shimMain("/opt/boat-offload/bin/boat-offload-node",
      ["--dry-run", "--runner", "bun", "--", "run", "test"], t.deps, NODE_SHIM);
    expect(exit).toBe(64);
  });

  it("prints help", async () => {
    const t = setup(PYTHON_SHIM, "/opt/boat-offload/bin/boat-offload-python");
    const exit = await shimMain("/opt/boat-offload/bin/boat-offload-python", ["--help"], t.deps, PYTHON_SHIM);
    expect(exit).toBe(0);
    expect(t.stdoutText()).toContain("boat-offload-python");
  });
});
