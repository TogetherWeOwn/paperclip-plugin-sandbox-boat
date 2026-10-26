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
    expect((await planDependencies(root({ "requirements.txt": "pytest\n" })))?.installs)
      .toEqual([{ lockfile: "requirements.txt", install: ["pip", "install", "-r", "requirements.txt"] }]);
    expect((await planDependencies(root({ "uv.lock": "x" })))?.installs)
      .toEqual([{ lockfile: "uv.lock", install: ["uv", "sync", "--frozen"] }]);
  });

  it("plans both ecosystems in a mixed repo", async () => {
    const plan = await planDependencies(root({ "package-lock.json": "x", "requirements.txt": "y\n" }));
    expect(plan?.installs).toHaveLength(2);
  });

  it("returns null on ambiguous competing lockfiles", async () => {
    expect(await planDependencies(root({ "package-lock.json": "x", "yarn.lock": "y" }))).toBe(null);
    expect(await planDependencies(root({ "uv.lock": "x", "requirements.txt": "y" }))).toBe(null);
  });

  it("keys the hash on lockfile contents", async () => {
    const a = await planDependencies(root({ "package-lock.json": "v1" }));
    const b = await planDependencies(root({ "package-lock.json": "v2" }));
    expect(a?.hash).not.toBe(b?.hash);
    const again = await planDependencies(root({ "package-lock.json": "v1" }));
    expect(a?.hash).toBe(again?.hash);
  });
});
