import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { isHandoverSourceOrigin, openHandoverSources } from "./test-support/handover-sources.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
describe("handover fixture containment", () => {
  it.each([
    "https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat",
    "https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "git@github.com:TogetherWeOwn/paperclip-plugin-sandbox-boat",
    "git@github.com:TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "ssh://git@github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat",
    "ssh://git@github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
  ])("accepts equivalent official source transports: %s", (origin) => {
    expect(isHandoverSourceOrigin(origin)).toBe(true);
  });

  it.each([
    "https://github.com/foreign/paperclip-plugin-sandbox-boat.git",
    "git@github.com:foreign/paperclip-plugin-sandbox-boat.git",
    "ssh://git@github.com/foreign/paperclip-plugin-sandbox-boat.git",
    "https://github.com/TogetherWeOwn/other.git",
    "https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat.git/extra",
    "https://github.com.invalid.example/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "https://github.com@invalid.example/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "ssh://git@invalid.example/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "http://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
    "file:///TogetherWeOwn/paperclip-plugin-sandbox-boat.git",
  ])("refuses foreign or noncanonical source origins: %s", (origin) => {
    expect(isHandoverSourceOrigin(origin)).toBe(false);
  });

  it("denies fetch, HTTP and socket entrypoints before pinned provider code loads", async () => {
    const sources = await openHandoverSources();
    try {
      expect(() => fetch("https://invalid.example")).toThrow("forbids real network");
      expect(() => http.get("http://invalid.example")).toThrow("forbids real network");
      expect(() => https.request("https://invalid.example")).toThrow("forbids real network");
      expect(() => net.connect(443, "invalid.example")).toThrow("forbids real network");
      expect(() => tls.connect(443, "invalid.example")).toThrow("forbids real network");
      const socket = new net.Socket();
      try { expect(() => socket.connect(443, "invalid.example")).toThrow("forbids real network"); }
      finally { socket.destroy(); }
    } finally { await sources.close(); }
  });

  it("uses verified source objects for archives both on Actions and in explicit host staging", async () => {
    const sourceRepo = process.env.HANDOVER_SOURCE_REPO || process.env.GITHUB_WORKSPACE || repo;
    const archive = await mkdtemp(resolve(repo, ".handover-archive-"));
    try {
      await mkdir(resolve(archive, "src/test-support"), { recursive: true });
      const helper = resolve(archive, "src/test-support/handover-sources.ts");
      await writeFile(helper, await readFile(new URL("./test-support/handover-sources.ts", import.meta.url)));
      vi.stubEnv("HANDOVER_SOURCE_REPO", "");
      vi.stubEnv("GITHUB_ACTIONS", "true"); vi.stubEnv("GITHUB_WORKSPACE", sourceRepo);
      const module = await import(helper);
      const sources = await module.openHandoverSources();
      try {
        expect(sources.old.root.startsWith(archive)).toBe(true);
        expect((await sources.candidate.load("src/account-ledger.ts")).AccountLedger).toBeTypeOf("function");
      } finally { await sources.close(); }
      vi.stubEnv("GITHUB_ACTIONS", "false");
      vi.stubEnv("HANDOVER_SOURCE_REPO", sourceRepo);
      const hostSources = await module.openHandoverSources();
      try {
        expect(hostSources.old.root.startsWith(archive)).toBe(true);
        expect((await hostSources.old.load("src/account-ledger.ts")).AccountLedger).toBeTypeOf("function");
      } finally { await hostSources.close(); }
      vi.stubEnv("HANDOVER_SOURCE_REPO", archive);
      await expect(module.openHandoverSources()).rejects.toThrow();
      vi.stubEnv("HANDOVER_SOURCE_REPO", "");
      await expect(module.openHandoverSources()).rejects.toThrow("require a verified source checkout");
    } finally { vi.unstubAllEnvs(); await rm(archive, { recursive: true, force: true }); }
  });

  it("passes only the archive's source repository to the stager test gate and propagates refusal", async () => {
    const root = await mkdtemp(resolve(repo, ".handover-stager-"));
    try {
      const bin = resolve(root, "bin"), packages = resolve(root, "packages"), temporary = resolve(root, "tmp");
      await Promise.all([bin, packages, temporary].map((dir) => mkdir(dir)));
      const commands = {
        git: `#!/bin/sh
if [ "$1" = rev-parse ]; then printf '%s\\n' "$STAGER_SOURCE"; exit; fi
shift 2
case "$1" in
  rev-parse) if [ "$2" = --short=7 ]; then printf 'abcdef1\\n'; else printf '%040d\\n' 1; fi ;;
  merge-base|archive) exit 0 ;;
  show) printf '{}\\n' ;;
  *) exit 99 ;;
esac
`,
        tar: "#!/bin/sh\nexit 0\n",
        node: "#!/bin/sh\nprintf '1.2.3\\n'\n",
        npm: `#!/bin/sh
if [ "$1" = ci ]; then exit 0; fi
[ "$1 $2" = 'run check' ] || exit 99
printf '%s\\n%s\\n' "$HANDOVER_SOURCE_REPO" "$PWD" > "$STAGER_LOG"
exit 71
`,
      };
      for (const [name, body] of Object.entries(commands)) await writeFile(resolve(bin, name), body, { mode: 0o755 });
      const log = resolve(root, "gate.log");
      // Every build/network-capable command is a sentinel; no suite, build or install runs here.
      const result = spawnSync("/bin/sh", [resolve(repo, "scripts/stage-package.sh"), "HEAD", packages], {
        cwd: repo, encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: temporary, GITHUB_ACTIONS: "false", HANDOVER_SOURCE_REPO: "must-be-overridden",
          STAGER_SOURCE: repo, STAGER_LOG: log },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(71);
      const [source, archive] = (await readFile(log, "utf8")).trim().split("\n");
      expect(source).toBe(repo);
      expect(archive).toMatch(/stage-sandbox-boat-[^/]+\/src$/);
      expect(await readdir(packages)).toEqual([]);
      expect(await readdir(temporary)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
