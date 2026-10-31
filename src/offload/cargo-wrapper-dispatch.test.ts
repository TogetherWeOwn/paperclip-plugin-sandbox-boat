// ADR 0001 §Interception: a repository build wrapper that dispatches Cargo
// through PATH (two-bot-next's scripts/cargo_cache.py: `shutil.which("cargo")`,
// then Popen with its own target/lean env) must reach the shim when the shim
// dir leads PATH, and a local fallback must run the real Cargo exactly once
// inside that wrapper's lease: no recursion, no second wrapper, wrapper env kept.
// Runs the real bin/boat-offload-cargo built from this tree against a fake broker.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../..");
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

// The dispatch half of cargo_cache.py run_cargo(), verbatim in behaviour:
// resolve_cargo() via shutil.which, child-only env overrides, bindir on PATH.
const WRAPPER = String.raw`
import os, shutil, subprocess, sys
found = shutil.which('cargo')
print('resolved=' + str(found), file=sys.stderr)
args = sys.argv[1:]
cargo_flags = args[:args.index('--')] if '--' in args else args
required = [f for f in ('--offline', '--locked') if f not in cargo_flags]
args = [args[0]] + required + args[1:]
env = os.environ.copy()
env.update(CARGO_TARGET_DIR='/pool/slot-0/target', CARGO_BUILD_TARGET_DIR='/pool/slot-0/target',
           CARGO_INCREMENTAL='0', CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_TEST_DEBUG='0',
           TMPDIR='/pool/slot-0/scratch')
bindir = os.path.dirname(found)
if bindir not in env.get('PATH', '').split(os.pathsep):
    env['PATH'] = os.pathsep.join(filter(None, (bindir, env.get('PATH'))))
child = subprocess.Popen([found] + args, env=env, start_new_session=True)
sys.exit(child.wait())
`;

// Fake real Cargo: records each invocation; optionally re-enters `cargo` by
// name and through the shim path (as a build script or cargo plugin could).
const REAL_CARGO = `#!/bin/sh
printf '%s\\n' "argv=$*|target=$CARGO_TARGET_DIR|active=$BOAT_OFFLOAD_SHIM_ACTIVE|path=$PATH" >> "$CALLS"
[ -n "$NESTED" ] && exit 0
if [ -n "$REENTER" ] && [ -z "$NESTED" ]; then
  NESTED=1 cargo metadata --format-version 1 || exit 90
  NESTED=1 "$REENTER" check || exit 91
fi
exit 7
`;

interface Broker {
  server: Server;
  url: string;
  requests: Array<{ url: string; body: Record<string, unknown> }>;
  mode: "local" | "remote_candidate";
}

let root: string;
let shimDir: string;
let realDir: string;
let broker: Broker;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "boat-wrapper-dispatch-"));
  // Build this tree so the real bin entrypoint runs (bin imports ../dist).
  execFileSync(process.execPath, [path.join(REPO, "node_modules/typescript/bin/tsc"), "-p", path.join(REPO, "tsconfig.build.json"),
    "--outDir", path.join(root, "pkg/dist")], { stdio: "pipe" });
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "pkg/node_modules"));
  mkdirSync(path.join(root, "pkg/bin"));
  copyFileSync(path.join(REPO, "bin/boat-offload-cargo"), path.join(root, "pkg/bin/boat-offload-cargo"));
  chmodSync(path.join(root, "pkg/bin/boat-offload-cargo"), 0o755);
  shimDir = path.join(root, "shim");
  realDir = path.join(root, "real");
  mkdirSync(shimDir);
  mkdirSync(realDir);
  symlinkSync(path.join(root, "pkg/bin/boat-offload-cargo"), path.join(shimDir, "cargo"));
  writeFileSync(path.join(realDir, "cargo"), REAL_CARGO, { mode: 0o755 });
  writeFileSync(path.join(root, "wrapper.py"), WRAPPER);

  const requests: Broker["requests"] = [];
  const state = { mode: "local" as Broker["mode"] };
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      requests.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (body.dryRun === true) {
        res.end(JSON.stringify({ version: 1, commandId: body.commandId, mode: state.mode, reason: "fake", profileId: "rust-public-1" }));
        return;
      }
      // Durable never-started refusal: the only receipt that permits fallback.
      res.statusCode = 503;
      res.end(JSON.stringify({ type: "about:blank", title: "unavailable", status: 503, code: "OFFLOAD_UNAVAILABLE", detail: "pool busy",
        retryable: true, next_action: "run local", commandId: body.commandId, remoteStarted: false, fallbackSafe: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  broker = { server, url: `http://127.0.0.1:${port}`, requests, get mode() { return state.mode; }, set mode(m) { state.mode = m; } };
}, 60_000);

afterAll(() => {
  broker?.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function runWrapper(argv: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string; calls: string[] }> {
  const calls = path.join(root, `calls-${Math.random().toString(36).slice(2)}.log`);
  const child = spawn("python3", ["-I", path.join(root, "wrapper.py"), ...argv], {
    // The shim's `#!/usr/bin/env node` needs node on PATH; CI installs it outside /usr/bin.
    env: { PATH: `${shimDir}:${realDir}:/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: root, CALLS: calls, PAPERCLIP_API_URL: broker.url, PAPERCLIP_API_KEY: "run-token",
      PAPERCLIP_WORKSPACE_ID: WS, PAPERCLIP_WORKSPACE_CWD: process.cwd(), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  return { code, stderr, calls: lines };
}

describe("cargo_cache.py-style dispatch through the cargo shim", () => {
  it("resolves the shim and, opted out, runs real Cargo once with the wrapper env", async () => {
    broker.requests.length = 0;
    const result = await runWrapper(["check", "--workspace"], {});
    expect(result.stderr).toContain(`resolved=${path.join(shimDir, "cargo")}`);
    expect(result.code).toBe(7);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("argv=check --offline --locked --workspace|target=/pool/slot-0/target|active=1|");
    expect(result.calls[0]!.split("|path=")[1]!.split(":")).not.toContain(shimDir);
    expect(broker.requests).toHaveLength(0);
  }, 30_000);

  it("consults the broker when opted in and falls back exactly once on a never-started refusal", async () => {
    for (const mode of ["local", "remote_candidate"] as const) {
      broker.mode = mode;
      broker.requests.length = 0;
      const result = await runWrapper(["test"], { BOAT_OFFLOAD: "1" });
      expect(result.code).toBe(7);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toContain("argv=test --offline --locked|target=/pool/slot-0/target|active=1|");
      const execs = broker.requests.filter((r) => r.body.dryRun === false);
      expect(broker.requests[0]!.body).toMatchObject({ dryRun: true, argv: ["test", "--offline", "--locked"] });
      expect(execs).toHaveLength(mode === "remote_candidate" ? 1 : 0);
      // Host target/lean/scratch settings never travel: the server profile owns guest settings.
      for (const request of broker.requests) expect(Object.keys(request.body.env as object)).toEqual([]);
    }
  }, 30_000);

  it("never recurses: nested cargo by name or through the shim path runs real Cargo directly", async () => {
    broker.mode = "local";
    broker.requests.length = 0;
    const result = await runWrapper(["build"], { BOAT_OFFLOAD: "1", REENTER: path.join(shimDir, "cargo") });
    expect(result.code).toBe(7);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[1]).toContain("argv=metadata --format-version 1|");
    expect(result.calls[2]).toContain("argv=check|");
    for (const call of result.calls) expect(call).toContain("|active=1|");
    // Only the outer command consulted the broker.
    expect(broker.requests).toHaveLength(1);
  }, 30_000);

  it("keeps a Postgres-dependent test local with zero broker calls", async () => {
    broker.mode = "remote_candidate";
    broker.requests.length = 0;
    const result = await runWrapper(["test", "-p", "two-bot"], { BOAT_OFFLOAD: "1", TWO_TEST_DATABASE_URL: "postgres://agent-testdb@localhost/two" });
    expect(result.code).toBe(7);
    expect(result.calls).toHaveLength(1);
    expect(broker.requests).toHaveLength(0);
  }, 30_000);
});
