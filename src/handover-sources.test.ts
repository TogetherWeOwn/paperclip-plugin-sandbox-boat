import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { openHandoverSources } from "./test-support/handover-sources.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
describe("handover fixture containment", () => {
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

  it("uses verified Actions source objects when package staging tests a git archive", async () => {
    const archive = await mkdtemp(resolve(repo, ".handover-archive-"));
    try {
      await mkdir(resolve(archive, "src/test-support"), { recursive: true });
      const helper = resolve(archive, "src/test-support/handover-sources.ts");
      await writeFile(helper, await readFile(new URL("./test-support/handover-sources.ts", import.meta.url)));
      vi.stubEnv("GITHUB_ACTIONS", "true"); vi.stubEnv("GITHUB_WORKSPACE", repo);
      const module = await import(helper);
      const sources = await module.openHandoverSources();
      try {
        expect(sources.old.root.startsWith(archive)).toBe(true);
        expect((await sources.candidate.load("src/account-ledger.ts")).AccountLedger).toBeTypeOf("function");
      } finally { await sources.close(); }
      vi.stubEnv("GITHUB_ACTIONS", "false");
      await expect(module.openHandoverSources()).rejects.toThrow("require a source checkout on Actions");
    } finally { vi.unstubAllEnvs(); await rm(archive, { recursive: true, force: true }); }
  });
});
