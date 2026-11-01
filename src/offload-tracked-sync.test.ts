import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containsSecretContent, hasSecretInFiles, listTrackedFiles } from "./offload-secret-scan.js";
import { hasRegistryCredentials } from "./offload-ssh-runtime.js";
import { captureManifest, captureSnapshot, isDefaultSyncExcluded } from "./offload-sync.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "offload-tracked-"));
  temps.push(dir);
  return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

/** A real git repo: tracked src/lib.rs + .gitignore, untracked .dev.vars, ignored secrets.pem. */
function gitRepo(extra: Record<string, string> = {}): string {
  const root = makeTemp();
  writeTree(root, {
    "src/lib.rs": "pub fn f() {}\n",
    ".gitignore": "secrets.pem\n",
    ".dev.vars": "CF_API_TOKEN=untracked-secret\n",
    "secrets.pem": "ignored-secret\n",
    ...extra,
  });
  git(root, "init", "-q", ".");
  git(root, "add", "src/lib.rs", ".gitignore", ...Object.keys(extra));
  return root;
}

describe("listTrackedFiles", () => {
  it("lists only index files of a git work tree", async () => {
    const root = gitRepo();
    expect([...(await listTrackedFiles(root))!].sort()).toEqual([".gitignore", "src/lib.rs"]);
  });

  it("returns null for a non-git source so the command stays local", async () => {
    const root = makeTemp();
    writeTree(root, { "src/lib.rs": "pub fn f() {}\n" });
    expect(await listTrackedFiles(root)).toBeNull();
  });

  it("returns an empty set for a git repo with nothing staged", async () => {
    const root = makeTemp();
    git(root, "init", "-q", ".");
    writeTree(root, { "src/lib.rs": "pub fn f() {}\n" });
    expect((await listTrackedFiles(root))!.size).toBe(0);
  });
});

describe("tracked-only capture", () => {
  it("manifests only tracked files: untracked .dev.vars and ignored secrets.pem never sync", async () => {
    const root = gitRepo();
    const tracked = await listTrackedFiles(root);
    const { manifest } = await captureManifest(root, { onlyPaths: tracked! });
    expect(manifest.files.map((f) => f.path).sort()).toEqual([".gitignore", "src/lib.rs"]);
  });

  it("freezes only tracked files into a snapshot", async () => {
    const root = gitRepo();
    const snap = makeTemp();
    const tracked = await listTrackedFiles(root);
    await captureSnapshot(root, snap, { onlyPaths: tracked! });
    expect(readFileSync(path.join(snap, "src/lib.rs"), "utf8")).toBe("pub fn f() {}\n");
    expect(() => readFileSync(path.join(snap, ".dev.vars"))).toThrow();
    expect(() => readFileSync(path.join(snap, "secrets.pem"))).toThrow();
  });

  it("an untracked escaping symlink neither syncs nor blocks a tracked-only capture", async () => {
    const root = gitRepo();
    execFileSync("ln", ["-s", "/etc/hostname", path.join(root, "src/evil.rs")]);
    const tracked = await listTrackedFiles(root);
    const { manifest } = await captureManifest(root, { onlyPaths: tracked! });
    expect(manifest.files.map((f) => f.path)).not.toContain("src/evil.rs");
  });

  it("aborts the capture when a tracked file carries a fake AWS key", async () => {
    const root = gitRepo({ "src/config.rs": "const K: &str = \"AKIAIOSFODNN7EXAMPLE\";\n" });
    const tracked = await listTrackedFiles(root);
    await expect(captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true }))
      .rejects.toMatchObject({ code: "SYNC_SECRET_CONTENT" });
  });
});

describe("secret content scan", () => {
  it.each([
    ["AWS access key", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n"],
    ["private key header", "-----BEGIN OPENSSH PRIVATE KEY-----\n"],
    ["GitHub token", `token = "ghp_${"a".repeat(36)}"\n`],
    ["JWT", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature\n"],
  ])("flags a tracked file with a %s", async (_label, content) => {
    const root = gitRepo({ "src/secret.rs": content });
    const tracked = [...(await listTrackedFiles(root))!].filter((rel) => !isDefaultSyncExcluded(rel));
    expect(await hasSecretInFiles(root, tracked)).toBe(true);
    expect(containsSecretContent(content)).toBe(true);
  });

  it("passes a clean tracked tree", async () => {
    const root = gitRepo();
    const tracked = [...(await listTrackedFiles(root))!].filter((rel) => !isDefaultSyncExcluded(rel));
    expect(await hasSecretInFiles(root, tracked)).toBe(false);
  });

  it("does not scan sync-excluded names, which never leave the host", async () => {
    // A tracked .env is excluded from sync by name, so admission does not
    // read it: the resolve() gate filters with isDefaultSyncExcluded first.
    expect(isDefaultSyncExcluded(".env")).toBe(true);
    expect(isDefaultSyncExcluded("secrets.pem")).toBe(true);
    expect(isDefaultSyncExcluded("config/prod.tfvars")).toBe(true);
    expect(isDefaultSyncExcluded(".aws/credentials")).toBe(true);
    expect(isDefaultSyncExcluded("src/lib.rs")).toBe(false);
  });
});

describe("stay-local secret-bearing names", () => {
  it.each([
    ".dev.vars", ".envrc", "deploy.pem", "tls.key", "id_rsa", "id_ed25519.pub",
    ".git-credentials", "gcp-credentials.json", "service-account-prod.json",
    "prod.tfvars", "terraform.tfstate", "terraform.tfstate.backup",
  ])("keeps commands local when %s is present", async (name) => {
    const root = makeTemp();
    writeTree(root, { [name]: "x\n", "package.json": "{}\n" });
    expect(await hasRegistryCredentials(root)).toBe(true);
  });

  it.each([".aws/credentials", ".docker/config.json", ".kube/config"])("keeps commands local for credential dir %s", async (rel) => {
    const root = makeTemp();
    writeTree(root, { [rel]: "x\n", "package.json": "{}\n" });
    expect(await hasRegistryCredentials(root)).toBe(true);
  });

  it("still allows a clean source", async () => {
    const root = makeTemp();
    writeTree(root, { "package.json": "{}\n", "keys.md": "not a key file\n" });
    expect(await hasRegistryCredentials(root)).toBe(false);
  });
});
