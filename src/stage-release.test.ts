import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// stage-release.sh puts a downloaded release tarball on a host, read-only and
// exactly as shipped: the package bundles a real copy of its pinned
// plugin-sdk, so there is no host SDK link to re-point (that link, absolute to
// the build host, made every tarball before 0.2.6 unloadable elsewhere).
// check-tarball-links.sh is the release-time guard against any link coming
// back. install-offload-shims.sh points a shim dir's cargo at the staged
// package. The rbx1 runbook (docs/operations/rbx1.md) relies on all three.
const stageRelease = path.resolve(__dirname, "../scripts/stage-release.sh");
const checkTarballLinks = path.resolve(__dirname, "../scripts/check-tarball-links.sh");
const installShims = path.resolve(__dirname, "../scripts/install-offload-shims.sh");
const stagePackage = path.resolve(__dirname, "../scripts/stage-package.sh");
const NAME = "sandbox-boat-1.2.3-abcdef1";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "stage-release-"));
  dirs.push(dir);
  return dir;
}

function sh(cwd: string, script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** A release tarball as release.yml builds it, with an optional twist. */
function release(dir: string, opts: { link?: "absolute-sdk" | "relative" | "hard"; noSdk?: boolean; version?: string; noBin?: boolean } = {}) {
  const src = path.join(dir, "src");
  const pkg = path.join(src, NAME);
  mkdirSync(path.join(pkg, "dist/offload"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "x", version: opts.version ?? "1.2.3" }));
  writeFileSync(path.join(pkg, ".source-commit"), "abcdef1234567890abcdef1234567890abcdef12\n");
  writeFileSync(path.join(pkg, "dist/worker.js"), "");
  writeFileSync(path.join(pkg, "dist/offload/shim-main.js"), "");
  if (!opts.noBin) {
    mkdirSync(path.join(pkg, "bin"));
    writeFileSync(path.join(pkg, "bin/boat-offload-cargo"), "#!/usr/bin/env node\n");
  }
  if (opts.link === "absolute-sdk") {
    // The pre-0.2.6 shape: the SDK as an absolute symlink to the build host.
    mkdirSync(path.join(pkg, "node_modules/@paperclipai"), { recursive: true });
    symlinkSync("/app/packages/plugins/sdk", path.join(pkg, "node_modules/@paperclipai/plugin-sdk"));
  } else if (!opts.noSdk) {
    const sdk = path.join(pkg, "node_modules/@paperclipai/plugin-sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "2026.1023.0" }));
  }
  if (opts.link === "relative") symlinkSync("worker.js", path.join(pkg, "dist/alias.js"));
  if (opts.link === "hard") linkSync(path.join(pkg, "dist/worker.js"), path.join(pkg, "dist/worker-hard.js"));
  spawnSync("chmod", ["-R", "a-w", pkg]);
  const out = path.join(dir, "dl");
  mkdirSync(out);
  const tgz = path.join(out, `${NAME}.tgz`);
  expect(spawnSync("tar", ["-czf", tgz, "-C", src, NAME]).status).toBe(0);
  const sum = spawnSync("sha256sum", [`${NAME}.tgz`], { cwd: out, encoding: "utf8" });
  writeFileSync(`${tgz}.sha256`, sum.stdout);
  return tgz;
}

const win = process.platform === "win32";

describe("stage-release.sh", () => {
  it.skipIf(win)("stages the package read-only with its bundled SDK copy untouched", () => {
    const dir = scratch();
    const tgz = release(dir);
    const root = path.join(dir, "root");
    mkdirSync(root);
    const r = sh(dir, stageRelease, [tgz, root]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const dest = path.join(root, NAME);
    expect(r.stdout.trim()).toBe(dest);
    const sdk = path.join(dest, "node_modules/@paperclipai/plugin-sdk");
    expect(lstatSync(sdk).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(sdk, "package.json"))).toBe(true);
    expect(statSync(dest).mode & 0o222).toBe(0);
    expect(statSync(path.join(dest, "dist/worker.js")).mode & 0o222).toBe(0);
    expect(existsSync(path.join(dest, "bin/boat-offload-cargo"))).toBe(true);
  });

  it.skipIf(win)("refuses the pre-0.2.6 tarball shape: an absolute plugin-sdk symlink", () => {
    const dir = scratch();
    const tgz = release(dir, { link: "absolute-sdk" });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const r = sh(dir, stageRelease, [tgz, root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("holds a link or special file");
    expect(existsSync(path.join(root, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a tarball with a relative link as well", () => {
    const dir = scratch();
    const tgz = release(dir, { link: "relative" });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const r = sh(dir, stageRelease, [tgz, root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("holds a link or special file");
    expect(existsSync(path.join(root, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a tarball with no bundled plugin-sdk", () => {
    const dir = scratch();
    const tgz = release(dir, { noSdk: true });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const r = sh(dir, stageRelease, [tgz, root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no bundled @paperclipai/plugin-sdk");
    expect(existsSync(path.join(root, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a host SDK path argument; there is nothing to re-point", () => {
    const dir = scratch();
    const tgz = release(dir);
    const r = sh(dir, stageRelease, [tgz, dir, "/app/packages/plugins/sdk"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unexpected argument");
  });

  it.skipIf(win)("refuses a tarball that does not match its .sha256", () => {
    const dir = scratch();
    const tgz = release(dir);
    writeFileSync(`${tgz}.sha256`, `${"0".repeat(64)}  ${NAME}.tgz\n`);
    const r = sh(dir, stageRelease, [tgz, dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match");
    expect(existsSync(path.join(dir, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a .sha256 that vouches for another file", () => {
    const dir = scratch();
    const tgz = release(dir);
    const decoy = path.join(path.dirname(tgz), "decoy.tgz");
    writeFileSync(decoy, "decoy");
    const sum = spawnSync("sha256sum", ["decoy.tgz"], { cwd: path.dirname(tgz), encoding: "utf8" });
    writeFileSync(`${tgz}.sha256`, sum.stdout);
    const r = sh(dir, stageRelease, [tgz, dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match");
  });

  it.skipIf(win)("refuses a package whose version disagrees with its name", () => {
    const dir = scratch();
    const tgz = release(dir, { version: "9.9.9" });
    const r = sh(dir, stageRelease, [tgz, dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match its package.json version 9.9.9");
  });

  it.skipIf(win)("refuses an existing destination and warns about a package without shims", () => {
    const dir = scratch();
    const tgz = release(dir, { noBin: true });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const first = sh(dir, stageRelease, [tgz, root]);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("has no bin/");
    const again = sh(dir, stageRelease, [tgz, root]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("already exists");
  });
});

describe("check-tarball-links.sh", () => {
  it.skipIf(win)("passes a tarball of plain files and directories", () => {
    const dir = scratch();
    const r = sh(dir, checkTarballLinks, [release(dir)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("holds no links");
  });

  it.skipIf(win)("fails a tarball with an absolute symlink", () => {
    const dir = scratch();
    const r = sh(dir, checkTarballLinks, [release(dir, { link: "absolute-sdk" })]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("holds a link");
    expect(r.stderr).toContain("/app/packages/plugins/sdk");
  });

  it.skipIf(win)("fails a tarball with a relative symlink or a hardlink", () => {
    const rel = scratch();
    expect(sh(rel, checkTarballLinks, [release(rel, { link: "relative" })]).status).not.toBe(0);
    const hard = scratch();
    expect(sh(hard, checkTarballLinks, [release(hard, { link: "hard" })]).status).not.toBe(0);
  });

  it.skipIf(win)("fails on a missing tarball", () => {
    const dir = scratch();
    expect(sh(dir, checkTarballLinks, [path.join(dir, "nope.tgz")]).status).not.toBe(0);
  });
});

describe("install-offload-shims.sh", () => {
  function pkg(dir: string) {
    const p = path.join(dir, "pkg");
    mkdirSync(path.join(p, "bin"), { recursive: true });
    mkdirSync(path.join(p, "dist/offload"), { recursive: true });
    writeFileSync(path.join(p, "bin/boat-offload-cargo"), "");
    writeFileSync(path.join(p, "dist/offload/shim-main.js"), "");
    return p;
  }

  it.skipIf(win)("links cargo to the package shim and re-points it on a second run", () => {
    const dir = scratch();
    const shims = path.join(dir, "shims");
    const first = pkg(dir);
    expect(sh(dir, installShims, [first, shims]).status).toBe(0);
    expect(readlinkSync(path.join(shims, "cargo"))).toBe(path.join(first, "bin/boat-offload-cargo"));
    const second = path.join(dir, "next");
    mkdirSync(second);
    const next = pkg(second);
    expect(sh(dir, installShims, [next, shims]).status).toBe(0);
    expect(readlinkSync(path.join(shims, "cargo"))).toBe(path.join(next, "bin/boat-offload-cargo"));
    expect(lstatSync(path.join(shims, "cargo")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(win)("refuses a package without the shim and never replaces a real cargo", () => {
    const dir = scratch();
    const bare = path.join(dir, "bare");
    mkdirSync(bare);
    expect(sh(dir, installShims, [bare, path.join(dir, "s")]).stderr).toContain("has no bin/boat-offload-cargo");
    const shims = path.join(dir, "shims");
    mkdirSync(shims);
    writeFileSync(path.join(shims, "cargo"), "real");
    chmodSync(path.join(shims, "cargo"), 0o755);
    const r = sh(dir, installShims, [pkg(dir), shims]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not a symlink");
  });
});

describe("stage-package.sh", () => {
  it.skipIf(win)("refuses a host SDK path argument; the SDK is bundled, not linked", () => {
    const dir = scratch();
    const r = sh(dir, stagePackage, ["HEAD", dir, "/app/packages/plugins/sdk"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unexpected argument");
  });
});
