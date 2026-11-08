import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { vi } from "vitest";

export const HANDOVER_SOURCES = {
  old: { commit: "ab50dd7b7027debc08c02a4f70e6cd77fc7f9618", tree: "830281ea6b0e63b0faa4cb4a512c840a6bc9e530" },
  candidate: { commit: "6250c7a6e1ad0cc0f496f11367c956f2aa7f5428", tree: "9ead7c773ed3fa78289fd39052a8db37336449af" },
} as const;

// Export only tracked source objects, never the installed package or host state.
// CI fetches the pinned objects before running tests; this helper never fetches.
export async function openHandoverSources() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  // stage-package tests a git archive on Actions. Resolve objects from that
  // job's verified checkout, while imports/dependencies stay in the archive.
  const sourceRepo = existsSync(resolve(repo, ".git")) ? repo
    : process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_WORKSPACE
      ? resolve(process.env.GITHUB_WORKSPACE) : null;
  if (!sourceRepo) throw new Error("pinned handover objects require a source checkout on Actions");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sourceRepo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (resolve(git("rev-parse", "--show-toplevel").trim()) !== sourceRepo
    || !/^https:\/\/github\.com\/TogetherWeOwn\/paperclip-plugin-sandbox-boat(?:\.git)?$/.test(git("config", "--get", "remote.origin.url").trim())) {
    throw new Error("handover source repository mismatch");
  }
  const base = await mkdtemp(resolve(repo, ".handover-fixture-"));
  const deny = () => { throw new Error("handover fixture forbids real network"); };
  const guards = [
    vi.spyOn(globalThis, "fetch").mockImplementation(deny),
    vi.spyOn(http, "request").mockImplementation(deny), vi.spyOn(http, "get").mockImplementation(deny),
    vi.spyOn(https, "request").mockImplementation(deny), vi.spyOn(https, "get").mockImplementation(deny),
    vi.spyOn(net, "connect").mockImplementation(deny), vi.spyOn(net, "createConnection").mockImplementation(deny),
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny),
    vi.spyOn(tls, "connect").mockImplementation(deny),
  ];
  async function close() {
    guards.forEach((guard) => guard.mockRestore());
    await rm(base, { recursive: true, force: true });
  }
  try {
    async function materialize(name: keyof typeof HANDOVER_SOURCES) {
      const pin = HANDOVER_SOURCES[name];
      if (git("rev-parse", `${pin.commit}^{commit}`).trim() !== pin.commit ||
          git("rev-parse", `${pin.commit}^{tree}`).trim() !== pin.tree) throw new Error("handover source identity mismatch");
      const root = resolve(base, name);
      await mkdir(root);
      const paths = git("ls-tree", "-r", "--name-only", pin.commit, "src", "scripts/install-offload-shims.sh", "bin", "package.json")
        .trim().split("\n").filter((path) => !path.endsWith(".test.ts") && !path.startsWith("src/test-support/"));
      for (const path of paths) {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), git("show", `${pin.commit}:${path}`));
      }
      return {
        root,
        // Each materialization has unique module URLs and independent caches.
        load: (path: string): Promise<any> => {
          if (!paths.includes(path) || !path.endsWith(".ts")) throw new Error("not a pinned production module");
          return import(resolve(root, path));
        },
      };
    }
    const old = await materialize("old"), candidate = await materialize("candidate");
    return { old, candidate, close };
  } catch (error) { await close(); throw error; }
}
