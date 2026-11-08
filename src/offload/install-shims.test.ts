// scripts/install-offload-shims.sh: alias set, idempotent upgrade, and
// all-or-nothing validation. Runs only against temp fixtures, never live paths.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/install-offload-shims.sh");

const ALIASES: Record<string, string> = {
  cargo: "boat-offload-cargo",
  npm: "boat-offload-node",
  pnpm: "boat-offload-node",
  yarn: "boat-offload-node",
  npx: "boat-offload-node",
  pytest: "boat-offload-python",
  python: "boat-offload-python",
  python3: "boat-offload-python",
};
const PKG_FILES = [
  "bin/boat-offload-cargo",
  "bin/boat-offload-node",
  "bin/boat-offload-python",
  "dist/offload/shim-main.js",
  "dist/offload/shim-node.js",
];

let root: string;

function makePkg(name: string, omit: string[] = []): string {
  const pkg = path.join(root, name);
  for (const f of PKG_FILES) {
    if (omit.includes(f)) continue;
    mkdirSync(path.dirname(path.join(pkg, f)), { recursive: true });
    writeFileSync(path.join(pkg, f), "#!/bin/sh\n");
  }
  return pkg;
}

function run(...args: string[]) {
  return spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8" });
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    out[entry] = lstatSync(p).isSymbolicLink() ? `link:${readlinkSync(p)}` : "other";
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "install-shims-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("install-offload-shims.sh", () => {
  it("links every alias to its bin and leaves no temporary entries", () => {
    const pkg = makePkg("pkg");
    const shims = path.join(root, "shims");
    const r = run(pkg, shims);
    expect(r.status).toBe(0);
    const expected: Record<string, string> = {};
    for (const [alias, bin] of Object.entries(ALIASES)) expected[alias] = `link:${pkg}/bin/${bin}`;
    expect(snapshot(shims)).toEqual(expected);
  });

  it("is idempotent and upgrades links to a new package", () => {
    const pkg1 = makePkg("pkg1");
    const pkg2 = makePkg("pkg2");
    const shims = path.join(root, "shims");
    expect(run(pkg1, shims).status).toBe(0);
    expect(run(pkg1, shims).status).toBe(0);
    expect(run(pkg2, shims).status).toBe(0);
    expect(readlinkSync(path.join(shims, "npx"))).toBe(`${pkg2}/bin/boat-offload-node`);
    expect(readlinkSync(path.join(shims, "python3"))).toBe(`${pkg2}/bin/boat-offload-python`);
    expect(readdirSync(shims).sort()).toEqual(Object.keys(ALIASES).sort());
  });

  it("replaces a dangling symlink", () => {
    const pkg = makePkg("pkg");
    const shims = path.join(root, "shims");
    mkdirSync(shims);
    symlinkSync(path.join(root, "gone"), path.join(shims, "pytest"));
    expect(run(pkg, shims).status).toBe(0);
    expect(readlinkSync(path.join(shims, "pytest"))).toBe(`${pkg}/bin/boat-offload-python`);
  });

  it("refuses a real-file destination without mutating any link", () => {
    const pkg = makePkg("pkg");
    const old = makePkg("old");
    const shims = path.join(root, "shims");
    expect(run(old, shims).status).toBe(0);
    rmSync(path.join(shims, "python3"));
    writeFileSync(path.join(shims, "python3"), "real");
    const before = snapshot(shims);
    const r = run(pkg, shims);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("python3");
    expect(snapshot(shims)).toEqual(before);
  });

  it("refuses a directory destination and creates nothing", () => {
    const pkg = makePkg("pkg");
    const shims = path.join(root, "shims");
    mkdirSync(path.join(shims, "yarn"), { recursive: true });
    const r = run(pkg, shims);
    expect(r.status).toBe(1);
    expect(readdirSync(shims)).toEqual(["yarn"]);
  });

  it.each(PKG_FILES)("refuses a package missing %s before touching the shim dir", (missing) => {
    const pkg = makePkg("pkg", [missing]);
    const shims = path.join(root, "shims");
    const r = run(pkg, shims);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(missing);
    expect(() => lstatSync(shims)).toThrow();
  });

  it("keeps existing links when the new package is incomplete", () => {
    const good = makePkg("good");
    const bad = makePkg("bad", ["bin/boat-offload-python"]);
    const shims = path.join(root, "shims");
    expect(run(good, shims).status).toBe(0);
    const before = snapshot(shims);
    expect(run(bad, shims).status).toBe(1);
    expect(snapshot(shims)).toEqual(before);
  });

  it("rejects invalid arguments", () => {
    const pkg = makePkg("pkg");
    const shims = path.join(root, "shims");
    expect(run().status).toBe(2);
    expect(run(pkg).status).toBe(2);
    expect(run(pkg, shims, "extra").status).toBe(2);
    expect(run("", shims).status).toBe(2);
    expect(run("relative/pkg", shims).status).toBe(1);
    expect(() => lstatSync(shims)).toThrow();
  });

  it("refuses a shim path that is a file", () => {
    const pkg = makePkg("pkg");
    const shims = path.join(root, "shims");
    writeFileSync(shims, "x");
    expect(run(pkg, shims).status).toBe(1);
  });
});
