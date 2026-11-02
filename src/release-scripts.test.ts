import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "./manifest.js";

// The release workflow runs these two scripts before it builds or publishes
// anything: a tag whose versions disagree, or whose CHANGELOG has no section,
// must fail the release.
const checkVersion = path.resolve(__dirname, "../scripts/check-release-version.sh");
const releaseNotes = path.resolve(__dirname, "../scripts/release-notes.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repoAt(tag: string, files: { pkg: string; manifest: string; changelog?: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-scripts-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: files.pkg }));
  writeFileSync(path.join(dir, "src/manifest.ts"), `export const PLUGIN_ID = "x";\nexport const PLUGIN_VERSION = "${files.manifest}";\n`);
  writeFileSync(path.join(dir, "CHANGELOG.md"), files.changelog ?? "# Changelog\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "release");
  git(dir, "tag", tag);
  return dir;
}

function run(script: string, cwd: string, tag: string) {
  return spawnSync("/bin/sh", [script, tag], { cwd, encoding: "utf8" });
}

describe("check-release-version.sh", () => {
  it.skipIf(process.platform === "win32")("passes when tag, package.json and PLUGIN_VERSION agree", () => {
    const r = run(checkVersion, repoAt("v1.2.3", { pkg: "1.2.3", manifest: "1.2.3" }), "v1.2.3");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("1.2.3");
  });

  it.skipIf(process.platform === "win32")("fails when package.json disagrees with the tag", () => {
    const r = run(checkVersion, repoAt("v1.2.4", { pkg: "1.2.3", manifest: "1.2.4" }), "v1.2.4");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("tag 1.2.4, package.json 1.2.3, PLUGIN_VERSION 1.2.4");
  });

  it.skipIf(process.platform === "win32")("fails when PLUGIN_VERSION disagrees with the tag", () => {
    const r = run(checkVersion, repoAt("v1.2.4", { pkg: "1.2.4", manifest: "1.2.3" }), "v1.2.4");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PLUGIN_VERSION 1.2.3");
  });

  it.skipIf(process.platform === "win32")("fails on a tag that is not vX.Y.Z or does not exist", () => {
    const dir = repoAt("v1.2.3", { pkg: "1.2.3", manifest: "1.2.3" });
    expect(run(checkVersion, dir, "1.2.3").status).not.toBe(0);
    expect(run(checkVersion, dir, "v9.9.9").stderr).toContain("unknown tag");
  });

  it("package.json and PLUGIN_VERSION agree on main", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  // The staged package bundles a real copy of the SDK its build used, since a
  // local-path install supplies none. That only stays true while the SDK is a
  // pinned runtime dependency: as a peer it was an absolute symlink to the
  // build host in every tarball before 0.2.6.
  it("pins @paperclipai/plugin-sdk as a runtime dependency, never a peer", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(pkg.dependencies["@paperclipai/plugin-sdk"]).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(pkg.peerDependencies?.["@paperclipai/plugin-sdk"]).toBeUndefined();
    expect(pkg.devDependencies?.["@paperclipai/plugin-sdk"]).toBeUndefined();
  });
});

describe("release-notes.sh", () => {
  const changelog = "# Changelog\n\n## 1.2.3\n\n### Fixed\n\n* a fix\n\n## 1.2.2\n\n* older\n";

  it.skipIf(process.platform === "win32")("prints the tag's CHANGELOG section without its heading", () => {
    const r = run(releaseNotes, repoAt("v1.2.3", { pkg: "1.2.3", manifest: "1.2.3", changelog }), "v1.2.3");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("### Fixed\n\n* a fix\n");
  });

  it.skipIf(process.platform === "win32")("fails when the CHANGELOG has no section for the tag", () => {
    const r = run(releaseNotes, repoAt("v1.2.4", { pkg: "1.2.4", manifest: "1.2.4", changelog }), "v1.2.4");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no 1.2.4 section");
  });
});
