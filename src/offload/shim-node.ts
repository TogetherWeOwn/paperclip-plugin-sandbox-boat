// Production wiring for boat-offload-cargo: fetch-based broker HTTP, real
// process spawn, executable search and rustup toolchain discovery. The run
// token travels in the Authorization header only, never in a request body.

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_ID } from "../manifest.js";
import type { BrokerHttp, HttpResult } from "./client.js";
import type { ShimDeps, SpawnResult } from "./shim-main.js";

const HTTP_TIMEOUT_MS = 30_000;

export function createFetchHttp(baseUrl: string, token: string): BrokerHttp {
  const call = async (method: string, urlPath: string, body?: unknown): Promise<HttpResult> => {
    try {
      const response = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      return { ok: true, status: response.status, json };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    post: (urlPath, body) => call("POST", urlPath, body),
    get: (urlPath) => call("GET", urlPath),
  };
}

export function createSpawn(): ShimDeps["spawn"] {
  return (exe, argv, env, options) =>
    new Promise<SpawnResult>((resolve) => {
      const child = nodeSpawn(exe, argv, { env, stdio: "inherit" });
      options?.onSpawn?.((signal) => {
        child.kill(signal);
      });
      child.on("error", () => resolve({ code: 127, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
}

export function createFindExecutable(): ShimDeps["findExecutable"] {
  return (dir, name) => {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  };
}

/** Installed toolchain short names from `rustup toolchain list`. Throws when rustup is missing. */
export function createReadToolchains(exec: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" })): () => string[] {
  return () => {
    const output = exec("rustup", ["toolchain", "list"]);
    return output
      .split("\n")
      .map((line) => line.trim().split(/\s/)[0] ?? "")
      .filter((name) => name.length > 0)
      .map((name) => name.split("-")[0]!);
  };
}

/** Compose production shim deps, discovering the registered plugin API base. */
export function createShimDeps(env: Record<string, string | undefined>): ShimDeps {
  const apiUrl = env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  const token = env.PAPERCLIP_API_KEY;
  // Without API wiring every broker call fails closed as a transport failure:
  // dry-run degrades to the default local path, diagnostics report the cause.
  const http: BrokerHttp =
    apiUrl && token
      ? createFetchHttp(`${apiUrl}/api/plugins/${PLUGIN_ID}/api`, token)
      : {
          post: async () => ({ ok: false as const, error: "missing PAPERCLIP_API_URL/PAPERCLIP_API_KEY" }),
          get: async () => ({ ok: false as const, error: "missing PAPERCLIP_API_URL/PAPERCLIP_API_KEY" }),
        };
  const handlers: Array<(signal: "SIGINT" | "SIGTERM") => void> = [];
  let armed = false;
  return {
    env,
    http,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (bytes) => process.stdout.write(bytes),
    stderr: (bytes) => process.stderr.write(bytes),
    onSignal: (handler) => {
      handlers.push(handler);
      if (!armed) {
        armed = true;
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          process.on(signal, () => {
            for (const fn of handlers) fn(signal);
          });
        }
      }
    },
    randomId: () => randomUUID(),
    findExecutable: createFindExecutable(),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    readToolchains: createReadToolchains(),
    spawn: createSpawn(),
  };
}
