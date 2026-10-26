import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasRegistryCredentials } from "./offload-ssh-runtime.js";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boat-creds-"));
  tmpdirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

describe("hasRegistryCredentials", () => {
  it("finds a root credential file", async () => {
    expect(await hasRegistryCredentials(root({ ".npmrc": "auth\n" }))).toBe(true);
  });

  it("finds a nested credential file at any depth", async () => {
    expect(await hasRegistryCredentials(root({ "packages/app/.npmrc": "auth\n" }))).toBe(true);
  });

  it("treats uv.toml as stay-local at any depth", async () => {
    expect(await hasRegistryCredentials(root({ "uv.toml": "[index]\n" }))).toBe(true);
    expect(await hasRegistryCredentials(root({ "packages/app/uv.toml": "[index]\n" }))).toBe(true);
  });

  it("treats pyproject.toml uv auth config as stay-local", async () => {
    const auth = `[project]\nname = "app"\n[tool.uv]\nindex-url = "https://user:secret@example.com/simple"\n`;
    expect(await hasRegistryCredentials(root({ "pyproject.toml": auth }))).toBe(true);
    const indexAuth = `[[tool.uv.index]]\nurl = "https://user:secret@example.com/simple"\n`;
    expect(await hasRegistryCredentials(root({ "packages/app/pyproject.toml": indexAuth }))).toBe(true);
  });

  it("allows pyproject.toml uv config without auth", async () => {
    const clean = `[project]\nname = "app"\n[tool.uv]\nmanaged = true\n`;
    expect(await hasRegistryCredentials(root({ "pyproject.toml": clean }))).toBe(false);
  });

  it("ignores credential names inside excluded dirs", async () => {
    expect(await hasRegistryCredentials(root({ "node_modules/.npmrc": "auth\n" }))).toBe(false);
  });

  it("returns false for a clean source", async () => {
    expect(await hasRegistryCredentials(root({ "package.json": "{}" }))).toBe(false);
  });

  it("stays local on a symlinked pyproject.toml without reading its large target", async () => {
    const dir = root({ "target.txt": `[project]\nname = "app"\n${"x".repeat(300 * 1024)}\n` });
    symlinkSync(path.join(dir, "target.txt"), path.join(dir, "pyproject.toml"));
    expect(await hasRegistryCredentials(dir)).toBe(true);
  });
});
