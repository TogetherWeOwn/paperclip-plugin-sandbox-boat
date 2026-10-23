import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ID } from "../manifest.js";
import { createFetchHttp, createFindExecutable, createReadToolchains, createShimDeps, createSpawn } from "./shim-node.js";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createFetchHttp", () => {
  it("posts JSON with the run token in headers and targets the registered plugin base", async () => {
    const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: text });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version: 1 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const http = createFetchHttp(`http://127.0.0.1:${port}/api/plugins/${PLUGIN_ID}/api`, "run-token-secret");
      const result = await http.post("/offload/exec", { version: 1, dryRun: true });
      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`/api/plugins/${PLUGIN_ID}/api/offload/exec`);
      expect(seen[0]!.auth).toBe("Bearer run-token-secret");
      expect(seen[0]!.body).not.toContain("run-token-secret");
    } finally {
      server.close();
    }
  });

  it("reports a transport failure instead of throwing", async () => {
    const http = createFetchHttp("http://127.0.0.1:1/unreachable", "token");
    const result = await http.post("/offload/exec", {});
    expect(result.ok).toBe(false);
  });
});

describe("createSpawn", () => {
  it("runs a command and reports its exit code", async () => {
    const spawn = createSpawn();
    const out: Buffer[] = [];
    const result = await spawn("/bin/sh", ["-c", "echo hi; exit 3"], { ...process.env as Record<string, string>, BOAT_TEST: "1" });
    expect(result.code).toBe(3);
    expect(out).toHaveLength(0);
  });

  it("reports a terminating signal", async () => {
    const spawn = createSpawn();
    const result = await spawn("/bin/sh", ["-c", "kill -TERM $$"], process.env as Record<string, string>);
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });
});

describe("createFindExecutable", () => {
  it("finds executables and skips the rest", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "boat-shim-"));
    tmpdirs.push(dir);
    const exe = path.join(dir, "cargo");
    writeFileSync(exe, "#!/bin/sh\necho cargo\n");
    chmodSync(exe, 0o755);
    writeFileSync(path.join(dir, "notaexe"), "x");
    const find = createFindExecutable();
    expect(find(dir, "cargo")).toBe(exe);
    expect(find(dir, "missing")).toBeNull();
    expect(find(dir, "notaexe")).toBeNull();
  });
});

describe("createReadToolchains", () => {
  it("parses installed toolchains and propagates discovery failure", () => {
    const read = createReadToolchains(() => "stable-x86_64-unknown-linux-gnu (default)\n1.88.0-x86_64-unknown-linux-gnu\n");
    expect(read()).toEqual(["stable", "1.88.0"]);
    const failing = createReadToolchains(() => {
      throw new Error("no rustup");
    });
    expect(() => failing()).toThrow("no rustup");
  });
});

describe("createShimDeps", () => {
  it("discovers the registered plugin base from PAPERCLIP_API_URL", async () => {
    let seenUrl = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, commandId: "c", mode: "local", reason: "x", profileId: "p" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const deps = createShimDeps({ PAPERCLIP_API_URL: `http://127.0.0.1:${port}`, PAPERCLIP_API_KEY: "k" });
      await deps.http.post("/offload/exec", { dryRun: true });
      expect(seenUrl).toBe(`/api/plugins/${PLUGIN_ID}/api/offload/exec`);
    } finally {
      server.close();
    }
  });

  it("builds without API wiring and reports calls as transport failures", async () => {
    const deps = createShimDeps({});
    expect(await deps.http.post("/offload/exec", {})).toMatchObject({ ok: false });
    expect(await deps.http.get("/offload/commands/x")).toMatchObject({ ok: false });
  });
});
