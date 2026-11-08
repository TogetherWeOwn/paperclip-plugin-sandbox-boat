import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHandoverSources } from "../test-support/handover-sources.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af", WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
const principal = { companyId: "synthetic-company", runId: "synthetic-run", cardId: "synthetic-card", repoId: "synthetic-repo", profileId: "secret-free" };
const pairs = [["old", "old"], ["old", "candidate"], ["candidate", "old"], ["candidate", "candidate"]] as const;
let sources: Awaited<ReturnType<typeof openHandoverSources>>;
beforeEach(async () => { sources = await openHandoverSources(); });
afterEach(async () => { await sources.close(); });

async function bridge(version: "old" | "candidate", mode: "complete" | "refuse" | "ambiguous" = "complete") {
  const { OffloadBroker } = await sources[version].load("src/offload/broker.ts");
  const { validateSubmit } = await sources[version].load("src/offload/validate.ts");
  const { offloadError } = await sources[version].load("src/offload/errors.ts");
  const rows = new Map<string, unknown>();
  const starts = vi.fn((_command: unknown, sink: any) => {
    if (mode === "ambiguous") { sink.started(); sink.fail(new Error("synthetic lost transport")); }
    else { sink.started(); sink.complete({ exitCode: 23, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } }); }
    return { done: new Promise<void>(() => {}), cancel: async () => {} };
  });
  const broker = new OffloadBroker({ now: () => 1000, store: {
    get: async (key: string) => structuredClone(rows.get(key) ?? null),
    set: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)); },
    delete: async (key: string) => { rows.delete(key); },
  }, backend: { start: starts } });
  const submissions: any[] = [], invalid: string[] = [];
  const http = {
    post: async (path: string, body: any) => {
      if (path !== "/offload/exec") return { ok: true, status: 200, json: {} };
      submissions.push(structuredClone(body));
      const validated = validateSubmit(body, { tool: body.tool ?? "cargo", runners: ["npm", "pnpm", "yarn", "npx", "pytest", "python", "python3"] });
      if (!validated.ok) { invalid.push(validated.detail); return { ok: true, status: 400, json: offloadError("OFFLOAD_INVALID_REQUEST", validated.detail) }; }
      if (body.dryRun) return { ok: true, status: 200, json: { mode: "remote_candidate", reason: "synthetic eligible command", profileId: "secret-free" } };
      if (mode === "refuse") await broker.recordRefusal(validated.value, principal, "synthetic capacity refusal");
      const response = await broker.submit(validated.value, principal);
      return { ok: true, status: response.status, json: response.body };
    },
    get: async () => { const response = await broker.read(CMD, principal, 0); return { ok: true, status: response.status, json: response.body }; },
  };
  let time = 1000;
  const runLocal = vi.fn(async () => 17), reportUnknown = vi.fn();
  const deps = { http, now: () => time, sleep: async (ms: number) => { time += ms; }, stdout() {}, stderr() {},
    onSignal() {}, randomId: () => CMD, runLocal, reportStaged() {}, reportUnknown };
  return { deps, submissions, invalid, starts, runLocal, reportUnknown };
}
const request = (tool = "cargo") => ({ tool, runner: tool === "cargo" ? undefined : tool === "node" ? "npm" : "pytest",
  argv: tool === "cargo" ? ["test", "--locked"] : ["test"], cwdRelative: ".", executionWorkspaceId: WS,
  queueTimeoutMs: 30000, timeoutMs: 1200000, processEnv: {} });

describe("actual pinned client ↔ validator/broker pairings", () => {
  it.each(pairs)("%s client → %s broker executes each common tool once", async (clientVersion, brokerVersion) => {
    const client = await sources[clientVersion].load("src/offload/client.ts");
    for (const tool of ["cargo", "node", "python"]) {
      const b = await bridge(brokerVersion);
      expect(await client.runOffload(request(tool), b.deps)).toBe(23);
      expect(b.starts).toHaveBeenCalledTimes(1);
      expect(b.runLocal).not.toHaveBeenCalled();
      expect(b.submissions).toHaveLength(1);
      expect(b.submissions[0].version).toBe(1);
    }
  });

  it.each(pairs)("%s client → %s broker permits one local fallback only on a never-started receipt", async (clientVersion, brokerVersion) => {
    const client = await sources[clientVersion].load("src/offload/client.ts");
    const b = await bridge(brokerVersion, "refuse");
    expect(await client.runOffload(request(), b.deps)).toBe(17);
    expect(b.starts).not.toHaveBeenCalled();
    expect(b.runLocal).toHaveBeenCalledExactlyOnceWith(["test", "--locked"]);
    expect(b.submissions).toHaveLength(1);
  });

  it.each(pairs)("%s client → %s broker never resubmits or falls back after ambiguous transport", async (clientVersion, brokerVersion) => {
    const client = await sources[clientVersion].load("src/offload/client.ts");
    const b = await bridge(brokerVersion, "ambiguous");
    expect(await client.runOffload(request(), b.deps)).toBe(75);
    expect(b.starts).toHaveBeenCalledTimes(1);
    expect(b.runLocal).not.toHaveBeenCalled();
    expect(b.submissions).toHaveLength(1);
  });

  it.each(["old", "candidate"] as const)("candidate depSelection against %s retains strict version-1 validation", async (brokerVersion) => {
    const client = await sources.candidate.load("src/offload/client.ts");
    const oldProtocol = await sources.old.load("src/offload/protocol.ts");
    const newProtocol = await sources.candidate.load("src/offload/protocol.ts");
    expect(oldProtocol.OFFLOAD_VERSION).toBe(1); expect(newProtocol.OFFLOAD_VERSION).toBe(1);
    const b = await bridge(brokerVersion);
    const exit = await client.runOffload({ ...request("python"), depSelection: { uvExtra: "test", cwdRelative: "." } }, b.deps);
    if (brokerVersion === "old") {
      expect(exit).toBe(64);
      expect(b.invalid).toEqual(['unknown key "depSelection"']);
      expect(b.starts).not.toHaveBeenCalled();
      expect(b.runLocal).not.toHaveBeenCalled();
    } else { expect(exit).toBe(23); expect(b.starts).toHaveBeenCalledTimes(1); }
    expect(b.submissions).toHaveLength(1);
  });

  it.each(["old", "candidate"] as const)("%s shim falls back to each same-name executable without shim recursion", async (version) => {
    const { shimMain, CARGO_SHIM, NODE_SHIM, PYTHON_SHIM } = await sources[version].load("src/offload/shim-main.ts");
    for (const name of ["cargo", "npm", "pnpm", "yarn", "npx", "pytest", "python", "python3"]) {
      const b = await bridge(version, "refuse");
      const spawn = vi.fn(async (_exe: string, _argv: string[], _env: Record<string, string>) => ({ code: 17, signal: null }));
      const tool = name === "cargo" ? CARGO_SHIM : ["npm", "pnpm", "yarn", "npx"].includes(name) ? NODE_SHIM : PYTHON_SHIM;
      const argv = name === "cargo" ? ["test", "--locked"] : name.startsWith("python") ? ["-m", "pytest"] : name === "pytest" ? ["tests/"] : ["test"];
      const deps = { ...b.deps, env: { BOAT_OFFLOAD: "1", PATH: "/synthetic/shims:/synthetic/real", PAPERCLIP_WORKSPACE_ID: WS, PAPERCLIP_WORKSPACE_CWD: "/synthetic/repo" },
        cwd: () => "/synthetic/repo", canonicalDir: (value: string) => value,
        realpath: (value: string) => value, readToolchains: () => ["stable"],
        findExecutable: (dir: string, executable: string) => `${dir}/${executable}`, spawn };
      expect(await shimMain(`/synthetic/shims/${name}`, argv, deps, tool)).toBe(17);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toBe(`/synthetic/real/${name}`);
      const env = (spawn.mock.calls as unknown as any[][])[0]![2];
      expect(env.PATH).toBe("/synthetic/real");
      expect(env.BOAT_OFFLOAD_SHIM_ACTIVE).toBe("1");
      expect(b.starts).not.toHaveBeenCalled();
    }
  });
});
