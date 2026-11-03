import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containsSecretContent, hasSecretInFiles, isCertificateOnlyPem, listTrackedFiles, pemFilesAreCertificateOnly } from "./offload-secret-scan.js";
import { hasRegistryCredentials } from "./offload-ssh-runtime.js";
import { captureManifest, captureSnapshot, collectAndStage, isCertificatePemSyncCandidate, isDefaultSyncExcluded, LocalGuestStore } from "./offload-sync.js";

/** The public ISRG Root X1 CA certificate: the exact shape that kept
 * two-bot-next local before the certificate-only .pem exception. */
const PUBLIC_CA_PEM = readFileSync(new URL("./test-support/isrg-root-x1.pem", import.meta.url), "utf8");
const FAKE_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBBQ==\n-----END PRIVATE KEY-----\n";

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

  it("ignores hostile GIT_* worker env when listing", async () => {
    const root = gitRepo();
    const decoy = gitRepo({ "decoy.txt": "x\n" });
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_DIR: path.join(decoy, ".git"), GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: path.join(decoy, ".git/index"), GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: decoy });
    try { expect([...(await listTrackedFiles(root))!].sort()).toEqual([".gitignore", "src/lib.rs"]); }
    finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
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

describe("certificate-only .pem exception", () => {
  it("accepts a real public CA certificate and a certificate bundle", () => {
    expect(isCertificateOnlyPem(PUBLIC_CA_PEM)).toBe(true);
    expect(isCertificateOnlyPem(PUBLIC_CA_PEM + PUBLIC_CA_PEM)).toBe(true);
    expect(isCertificateOnlyPem(PUBLIC_CA_PEM.replaceAll("\n", "\r\n"))).toBe(true);
  });

  it.each([
    ["a private key", FAKE_PRIVATE_KEY_PEM],
    ["a mixed cert+key bundle", PUBLIC_CA_PEM + FAKE_PRIVATE_KEY_PEM],
    ["a malformed certificate block", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"],
    ["text outside the blocks", `Bag Attributes\n${PUBLIC_CA_PEM}`],
    ["trailing text after the block", `${PUBLIC_CA_PEM}secret-suffix\n`],
    ["an empty file", ""],
    ["whitespace only", "\n  \n"],
  ])("refuses %s", (_label, content) => {
    expect(isCertificateOnlyPem(content)).toBe(false);
  });

  it("refuses bytes smuggled after the certificate inside its own block", () => {
    // OpenSSL parses a cert with garbage appended to the DER; only the
    // cert.raw byte-equality in isCertificateOnlyPem catches this.
    const b64 = PUBLIC_CA_PEM.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/-----END CERTIFICATE-----/, "").replace(/\s+/g, "");
    const der = Buffer.concat([Buffer.from(b64, "base64"), Buffer.from("smuggled-secret")]);
    // Precondition, pinned so this test cannot silently regress to being
    // rejected by an earlier shape check: the smuggled DER parses as a
    // certificate, and the parsed certificate is shorter than the DER.
    const parsed = new X509Certificate(der);
    expect(parsed.raw.equals(der)).toBe(false);
    const smuggled = der.toString("base64");
    const wrapped = smuggled.replace(/(.{64})/g, "$1\n");
    // The END marker must start on its own line: glued onto the last base64
    // line it would fail the strict base64-line check before ever reaching
    // the DER parse this test guards (smuggled length ≡ 20 mod 64).
    const pem = `-----BEGIN CERTIFICATE-----\n${wrapped.endsWith("\n") ? wrapped : `${wrapped}\n`}-----END CERTIFICATE-----\n`;
    expect(isCertificateOnlyPem(pem)).toBe(false);
  });

  it("refuses an oversized pem fail-closed", () => {
    expect(isCertificateOnlyPem(PUBLIC_CA_PEM.repeat(200))).toBe(false);
  });

  it("verifies files on disk but never follows a symlink or excuses a missing file", async () => {
    const root = makeTemp();
    writeTree(root, { "fixtures/ca.pem": PUBLIC_CA_PEM, "fixtures/key.pem": FAKE_PRIVATE_KEY_PEM });
    symlinkSync(path.join(root, "fixtures/ca.pem"), path.join(root, "fixtures/link.pem"));
    expect(await pemFilesAreCertificateOnly(root, ["fixtures/ca.pem"])).toBe(true);
    expect(await pemFilesAreCertificateOnly(root, ["fixtures/key.pem"])).toBe(false);
    expect(await pemFilesAreCertificateOnly(root, ["fixtures/link.pem"])).toBe(false);
    // A symlinked parent directory is refused too: the leaf check alone
    // would read a certificate outside the root that capture could never
    // sync (it does not descend through links).
    const outside = makeTemp();
    writeTree(outside, { "ca.pem": PUBLIC_CA_PEM });
    symlinkSync(outside, path.join(root, "linked"));
    expect(await pemFilesAreCertificateOnly(root, ["linked/ca.pem"])).toBe(false);
    expect(await pemFilesAreCertificateOnly(root, ["fixtures/missing.pem"])).toBe(false);
    expect(await pemFilesAreCertificateOnly(root, ["../outside.pem"])).toBe(false);
  });

  it("manifests a tracked public CA certificate so the guest tree is complete", async () => {
    const root = gitRepo({ "scripts/ci/fixtures/isrg-x1.pem": PUBLIC_CA_PEM });
    const tracked = await listTrackedFiles(root);
    const { manifest } = await captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true });
    expect(manifest.files.map((f) => f.path).sort()).toEqual([".gitignore", "scripts/ci/fixtures/isrg-x1.pem", "src/lib.rs"]);
    expect(isCertificatePemSyncCandidate("scripts/ci/fixtures/isrg-x1.pem")).toBe(true);
  });

  it.each([
    ["a private-key pem", FAKE_PRIVATE_KEY_PEM],
    ["a mixed cert+key bundle", PUBLIC_CA_PEM + FAKE_PRIVATE_KEY_PEM],
    ["a malformed pem", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"],
    ["an oversized pem", PUBLIC_CA_PEM.repeat(200)],
  ])("aborts the capture when a tracked file is %s", async (_label, content) => {
    const root = gitRepo({ "fixtures/ca.pem": content });
    const tracked = await listTrackedFiles(root);
    await expect(captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true }))
      .rejects.toMatchObject({ code: "SYNC_SECRET_CONTENT" });
  });

  it("aborts the capture when a tracked .pem is a symlink", async () => {
    const root = gitRepo();
    symlinkSync(path.join(root, "src/lib.rs"), path.join(root, "ca.pem"));
    git(root, "add", "ca.pem");
    const tracked = await listTrackedFiles(root);
    await expect(captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true }))
      .rejects.toMatchObject({ code: "SYNC_SECRET_CONTENT" });
  });

  it("aborts the capture when a parent dir of a verified cert is swapped for a symlink after admission", async () => {
    const root = gitRepo({ "fixtures/ca.pem": PUBLIC_CA_PEM });
    const tracked = await listTrackedFiles(root);
    // Admission verifies the certificate through the real directory.
    expect(await pemFilesAreCertificateOnly(root, ["fixtures/ca.pem"])).toBe(true);
    // Then the parent is swapped for a symlink to an identical tree outside
    // the root: capture must refuse, never silently manifest without the cert.
    const elsewhere = makeTemp();
    writeTree(elsewhere, { "ca.pem": PUBLIC_CA_PEM });
    renameSync(path.join(root, "fixtures"), path.join(root, "fixtures-real"));
    symlinkSync(elsewhere, path.join(root, "fixtures"));
    await expect(captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true }))
      .rejects.toMatchObject({ code: "SYNC_SECRET_CONTENT" });
  });

  it("only *.pem by name may be a sync candidate; every other barrier still applies", () => {
    expect(isCertificatePemSyncCandidate("ca.pem")).toBe(true);
    expect(isCertificatePemSyncCandidate("fixtures/ca.key")).toBe(false);
    expect(isCertificatePemSyncCandidate(".aws/ca.pem")).toBe(false);
    expect(isCertificatePemSyncCandidate("target/ca.pem")).toBe(false);
    expect(isCertificatePemSyncCandidate("state.tfstate.pem")).toBe(false);
    expect(isCertificatePemSyncCandidate(".env.pem")).toBe(false);
  });

  it("collect invents no delete for a scan-blind uploaded certificate", async () => {
    const root = gitRepo({ "fixtures/isrg-x1.pem": PUBLIC_CA_PEM });
    const tracked = await listTrackedFiles(root);
    const uploaded = (await captureManifest(root, { onlyPaths: tracked!, scanForSecrets: true })).manifest;
    const guest = makeTemp();
    writeTree(guest, { "src/lib.rs": "pub fn f() {}\n", ".gitignore": "secrets.pem\n", "fixtures/isrg-x1.pem": PUBLIC_CA_PEM });
    const result = await collectAndStage({ liveRoot: root, uploaded, guest: new LocalGuestStore(), guestDir: guest, stagingDir: path.join(makeTemp(), "stage") });
    expect(result.changes).toEqual([]);
    expect(result.state).toBe("clean");
  });

  it("registry-credential walk ignores only the verified certificate set", async () => {
    const root = makeTemp();
    writeTree(root, { "fixtures/ca.pem": PUBLIC_CA_PEM, "package.json": "{}\n" });
    expect(await hasRegistryCredentials(root)).toBe(true);
    expect(await hasRegistryCredentials(root, new Set(["fixtures/ca.pem"]))).toBe(false);
    expect(await hasRegistryCredentials(root, new Set(["fixtures/other.pem"]))).toBe(true);
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
