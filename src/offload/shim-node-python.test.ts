import { describe, expect, it, vi } from "vitest";
import type { HttpResult } from "./client.js";
import { NODE_SHIM, PYTHON_SHIM, shimMain, type ShimDeps } from "./shim-main.js";

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
