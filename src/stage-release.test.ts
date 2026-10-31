import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// stage-release.sh puts a downloaded release tarball on a host and points its
// plugin-sdk link at that host's SDK; install-offload-shims.sh points a shim
// dir's cargo at the staged package. The rbx1 runbook (docs/operations/rbx1.md)
// relies on both refusing anything but a checked package and a stable SDK path.
const stageRelease = path.resolve(__dirname, "../scripts/stage-release.sh");
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

function hostSdk(at: string, name = "@paperclipai/plugin-sdk") {
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, version: "2026.1023.0" }));
  return at;
}

/** A release tarball as release.yml builds it, with an optional twist. */
function release(dir: string, opts: { extraLink?: boolean; version?: string; noBin?: boolean } = {}) {
  const src = path.join(dir, "src");
  const pkg = path.join(src, NAME);
  mkdirSync(path.join(pkg, "dist/offload"), { recursive: true });
  mkdirSync(path.join(pkg, "node_modules/@paperclipai"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "x", version: opts.version ?? "1.2.3" }));
  writeFileSync(path.join(pkg, ".source-commit"), "abcdef1234567890abcdef1234567890abcdef12\n");
  writeFileSync(path.join(pkg, "dist/worker.js"), "");
  writeFileSync(path.join(pkg, "dist/offload/shim-main.js"), "");
  if (!opts.noBin) {
    mkdirSync(path.join(pkg, "bin"));
    writeFileSync(path.join(pkg, "bin/boat-offload-cargo"), "#!/usr/bin/env node\n");
  }
  symlinkSync("/app/packages/plugins/sdk", path.join(pkg, "node_modules/@paperclipai/plugin-sdk"));
  if (opts.extraLink) symlinkSync("/etc/passwd", path.join(pkg, "dist/evil.js"));
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
  it.skipIf(win)("stages the package read-only with the SDK linked to the given host path", () => {
    const dir = scratch();
    const tgz = release(dir);
    const root = path.join(dir, "root");
    mkdirSync(root);
    const sdk = hostSdk(path.join(dir, "home/.paperclip/cli/current/node_modules/@paperclipai/plugin-sdk"));
    const r = sh(dir, stageRelease, [tgz, root, sdk]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const dest = path.join(root, NAME);
    expect(r.stdout.trim()).toBe(dest);
    expect(readlinkSync(path.join(dest, "node_modules/@paperclipai/plugin-sdk"))).toBe(sdk);
    expect(statSync(dest).mode & 0o222).toBe(0);
    expect(statSync(path.join(dest, "dist/worker.js")).mode & 0o222).toBe(0);
    expect(existsSync(path.join(dest, "bin/boat-offload-cargo"))).toBe(true);
  });

  it.skipIf(win)("defaults to $PAPERCLIP_HOME/cli/current and keeps that path unresolved", () => {
    const dir = scratch();
    const tgz = release(dir);
    const root = path.join(dir, "root");
    mkdirSync(root);
    const home = path.join(dir, "ph");
    hostSdk(path.join(home, "cli/installs/npm/2026.1023.0/node_modules/@paperclipai/plugin-sdk"));
    mkdirSync(path.join(home, "cli"), { recursive: true });
    symlinkSync("installs/npm/2026.1023.0", path.join(home, "cli/current"));
    const r = sh(dir, stageRelease, [tgz, root], { PAPERCLIP_HOME: home });
    expect(r.status).toBe(0);
    expect(readlinkSync(path.join(root, NAME, "node_modules/@paperclipai/plugin-sdk")))
      .toBe(path.join(home, "cli/current/node_modules/@paperclipai/plugin-sdk"));
  });

  it.skipIf(win)("refuses an SDK path inside a versioned Paperclip install", () => {
    const dir = scratch();
    const tgz = release(dir);
    const sdk = hostSdk(path.join(dir, "ph/cli/installs/npm/2026.1023.0/node_modules/@paperclipai/plugin-sdk"));
    const r = sh(dir, stageRelease, [tgz, dir, sdk]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("link through cli/current");
  });

  it.skipIf(win)("refuses a host path that is not the plugin SDK", () => {
    const dir = scratch();
    const tgz = release(dir);
    const r = sh(dir, stageRelease, [tgz, dir, hostSdk(path.join(dir, "other"), "left-pad")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not a @paperclipai/plugin-sdk package");
  });

  it.skipIf(win)("refuses a tarball that does not match its .sha256", () => {
    const dir = scratch();
    const tgz = release(dir);
    writeFileSync(`${tgz}.sha256`, `${"0".repeat(64)}  ${NAME}.tgz\n`);
    const r = sh(dir, stageRelease, [tgz, dir, hostSdk(path.join(dir, "sdk"))]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match");
    expect(existsSync(path.join(dir, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a tarball with any other link", () => {
    const dir = scratch();
    const tgz = release(dir, { extraLink: true });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const r = sh(dir, stageRelease, [tgz, root, hostSdk(path.join(dir, "sdk"))]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("other than node_modules/@paperclipai/plugin-sdk");
    expect(existsSync(path.join(root, NAME))).toBe(false);
  });

  it.skipIf(win)("refuses a package whose version disagrees with its name", () => {
    const dir = scratch();
    const tgz = release(dir, { version: "9.9.9" });
    const r = sh(dir, stageRelease, [tgz, dir, hostSdk(path.join(dir, "sdk"))]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match its package.json version 9.9.9");
  });

  it.skipIf(win)("refuses an existing destination and warns about a package without shims", () => {
    const dir = scratch();
    const tgz = release(dir, { noBin: true });
    const root = path.join(dir, "root");
    mkdirSync(root);
    const sdk = hostSdk(path.join(dir, "sdk"));
    const first = sh(dir, stageRelease, [tgz, root, sdk]);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain("has no bin/");
    const again = sh(dir, stageRelease, [tgz, root, sdk]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("already exists");
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
  it.skipIf(win)("refuses a host SDK path inside a versioned Paperclip install", () => {
    const dir = scratch();
    const r = sh(dir, stagePackage, ["HEAD", dir, "/home/u/.paperclip/cli/installs/npm/2026.1023.0/node_modules/@paperclipai/plugin-sdk"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("link through cli/current");
  });
});
