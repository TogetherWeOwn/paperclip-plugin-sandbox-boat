import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planDependencies } from "./deps-install.js";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boat-deps-"));
  tmpdirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

describe("planDependencies", () => {
  it("returns null with no lockfile", async () => {
    expect(await planDependencies(root({ "package.json": "{}" }))).toBe(null);
    expect(await planDependencies(root({ "pyproject.toml": "[project]" }))).toBe(null);
  });

  it("plans npm ci from package-lock.json", async () => {
    const plan = await planDependencies(root({ "package-lock.json": "{\"lockfileVersion\":3}" }));
    expect(plan?.installs).toEqual([{ lockfile: "package-lock.json", install: ["npm", "ci"] }]);
    expect(plan?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("plans pnpm and yarn frozen installs", async () => {
    expect((await planDependencies(root({ "pnpm-lock.yaml": "x" })))?.installs)
      .toEqual([{ lockfile: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"] }]);
    expect((await planDependencies(root({ "yarn.lock": "x" })))?.installs)
      .toEqual([{ lockfile: "yarn.lock", install: ["yarn", "install", "--frozen-lockfile"] }]);
  });

  it("plans pip and uv installs", async () => {
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    expect((await planDependencies(root({ "requirements.txt": pinned })))?.installs)
      .toEqual([{ lockfile: "requirements.txt", install: ["pip", "install", "--require-hashes", "-r", "requirements.txt"] }]);
    expect((await planDependencies(root({ "uv.lock": "x" })))?.installs)
      .toEqual([{ lockfile: "uv.lock", install: ["uv", "sync", "--frozen"] }]);
  });

  it("stays local on unpinned requirements.txt", async () => {
    expect(await planDependencies(root({ "requirements.txt": "pytest\n" }))).toBe(null);
    expect(await planDependencies(root({ "requirements.txt": "pytest>=7\n" }))).toBe(null);
    expect(await planDependencies(root({ "requirements.txt": "pytest==7.4.2\n" }))).toBe(null);
  });

  it("stays local on a malformed pinned specifier", async () => {
    expect(await planDependencies(root({ "requirements.txt": "pytest== --hash=sha256:abc123\n" }))).toBe(null);
  });

  it("stays local on an editable VCS requirement", async () => {
    const mixed = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n-e git+https://example.com/pkg.git#egg=pkg\n";
    expect(await planDependencies(root({ "requirements.txt": mixed }))).toBe(null);
  });

  it("stays local on an extra-index-url option", async () => {
    const mixed = "--extra-index-url https://example.com/simple\npytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    expect(await planDependencies(root({ "requirements.txt": mixed }))).toBe(null);
  });

  it("scopes ambiguity to the requested tool", async () => {
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    const both = root({ "package-lock.json": "x", "yarn.lock": "y", "requirements.txt": pinned });
    expect(await planDependencies(both, "python")).not.toBe(null);
    expect(await planDependencies(both, "node")).toBe(null);
    const bothPy = root({ "package-lock.json": "x", "requirements.txt": pinned });
    expect((await planDependencies(bothPy, "python"))?.installs).toHaveLength(1);
  });

  it("plans both ecosystems in a mixed repo", async () => {
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    const plan = await planDependencies(root({ "package-lock.json": "x", "requirements.txt": pinned }));
    expect(plan?.installs).toHaveLength(2);
  });

  it("ignores unpinned requirements beside uv.lock", async () => {
    const plan = await planDependencies(root({ "uv.lock": "x", "requirements.txt": "pytest\n" }));
    expect(plan?.installs).toEqual([{ lockfile: "uv.lock", install: ["uv", "sync", "--frozen"] }]);
  });

  it("returns null on ambiguous competing lockfiles", async () => {
    expect(await planDependencies(root({ "package-lock.json": "x", "yarn.lock": "y" }))).toBe(null);
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    expect(await planDependencies(root({ "uv.lock": "x", "requirements.txt": pinned }))).toBe(null);
  });

  it("keys the hash on lockfile contents", async () => {
    const a = await planDependencies(root({ "package-lock.json": "v1" }));
    const b = await planDependencies(root({ "package-lock.json": "v2" }));
    expect(a?.hash).not.toBe(b?.hash);
    const again = await planDependencies(root({ "package-lock.json": "v1" }));
    expect(a?.hash).toBe(again?.hash);
  });
});
