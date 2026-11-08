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
