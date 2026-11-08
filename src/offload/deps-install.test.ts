import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nestedLockfile, planDependencies } from "./deps-install.js";

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

// Same root/extra/metadata shape as a uv v1 revision 5 lock. No installation
// or network is needed: these tests exercise the host dependency plan only.
const uvManifest = `[project]
name = "example"
version = "0.1.0"
[project.optional-dependencies]
test = ["pytest>=7"]
api = ["client>=1"]
`;
const uvLock = `version = 1
revision = 5
[[package]]
name = "example"
version = "0.1.0"
source = { editable = "." }
[package.optional-dependencies]
test = [{ name = "pytest" }]
api = [{ name = "client" }]
[package.metadata]
requires-dist = [
  { name = "pytest", specifier = ">=7", marker = "extra == 'test'" },
  { name = "client", specifier = ">=1", marker = "extra == 'api'" },
]
provides-extras = ["api", "test"]
[[package]]
name = "pytest"
version = "9.2.0"
source = { registry = "https://pypi.org/simple" }
[[package]]
name = "client"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
`;
const testSelection = { uvExtra: "test", cwdRelative: "." } as const;
const uvFiles = () => ({ "pyproject.toml": uvManifest, "uv.lock": uvLock });

describe("explicit locked uv test extra", () => {
  it("adds only the selected test extra, with a distinct deterministic cache identity", async () => {
    const dir = root(uvFiles());
    const plain = await planDependencies(dir, "python");
    const selected = await planDependencies(dir, "python", testSelection);
    expect(plain?.installs[0]?.install).toEqual(["uv", "sync", "--frozen"]);
    expect(selected?.installs).toEqual([{ lockfile: "uv.lock", install: ["uv", "sync", "--frozen", "--extra", "test"] }]);
    expect(selected?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(selected?.hash).not.toBe(plain?.hash);
    expect((await planDependencies(dir, "python", testSelection))?.hash).toBe(selected?.hash);
    writeFileSync(path.join(dir, "pyproject.toml"), uvManifest + "# changed manifest\n");
    expect((await planDependencies(dir, "python", testSelection))?.hash).not.toBe(selected?.hash);
    expect((await planDependencies(dir, "python"))?.hash).toBe(plain?.hash);
    writeFileSync(path.join(dir, "uv.lock"), uvLock + "# changed lock\n");
    expect((await planDependencies(dir, "python", testSelection))?.hash).not.toBe(selected?.hash);
  });

  it("accepts a run directory inside the root project and virtual root locks", async () => {
    const dir = root({ ...uvFiles(), "tests/unit/case.py": "" });
    expect(await planDependencies(dir, "python", { ...testSelection, cwdRelative: "tests/unit" })).not.toBe(null);
    writeFileSync(path.join(dir, "uv.lock"), uvLock.replace("editable", "virtual"));
    expect(await planDependencies(dir, "python", testSelection)).not.toBe(null);
  });

  it("refuses a stale locked version even when manifest and lock metadata still match", async () => {
    const files = { ...uvFiles(), "uv.lock": uvLock.replace('version = "9.2.0"', 'version = "6.2.5"') };
    expect(await planDependencies(root(files), "python", testSelection)).toBe(null);
  });

  it.each([
    [">=7", "7", true], [">=7", "9.2.0", true], [">=7", "6.2.5", false],
    [">7", "7.0.0", false], [">7", "7.0.1", true],
    ["<=7", "7.0.0", true], ["<=7", "7.0.1", false],
    ["<7", "6.9", true], ["<7", "7.0", false],
    ["==7.0", "7", true], ["==7", "7.0.1", false],
    ["!=7", "7.0.0", false], ["!=7", "7.0.1", true],
    [">=7, <10, !=9.1", "9.2.0", true], [">=7,<10,!=9.1", "9.1.0", false],
    [">=7,<10", "10", false], ["", "9.2.0", true],
    ["~=7.0", "7.1", false], ["===7", "7", false], ["==7.*", "7.1", false],
    [">=1!7", "8", false], [">=7rc1", "8", false], [">=7.post1", "8", false],
    [">=7.dev1", "8", false], ["==7+local", "7", false], [">=v7", "8", false],
    [">=7", "7rc1", false], [">=7", "7.dev1", false], [">=7", "7.post1", false],
    [">=7", "7+local", false], [">=7", "1!8", false], [">=7", "v8", false],
    [">=7", "garbage", false], [">=7", "9.2.0.0.0.0.0.0.1", false],
    [">=7", "9999999999", false], [">=7.0.0.0.0.0.0.0.1", "9", false],
    [">=9999999999", "9", false],
  ])("checks bounded specifier %s against locked release %s", async (specifier, version, accepted) => {
    const files = {
      "pyproject.toml": uvManifest.replace("pytest>=7", `pytest${specifier}`),
      "uv.lock": uvLock.replace('specifier = ">=7"', `specifier = "${specifier}"`)
        .replace('version = "9.2.0"', `version = "${version}"`),
    };
    const plan = await planDependencies(root(files), "python", testSelection);
    if (accepted) expect(plan?.installs[0]?.install).toEqual(["uv", "sync", "--frozen", "--extra", "test"]);
    else expect(plan).toBe(null);
  });

  it.each([null, {}, [], { uvExtra: "api", cwdRelative: "." },
    { uvExtra: "--all-extras", cwdRelative: "." }, { uvExtra: ["test"], cwdRelative: "." },
    { ...testSelection, command: "anything" }, { ...testSelection, cwdRelative: "../escape" },
    { ...testSelection, cwdRelative: "/tmp" }, { ...testSelection, cwdRelative: "tests/../../escape" },
    { ...testSelection, cwdRelative: "" }, { ...testSelection, cwdRelative: "a".repeat(4097) },
  ])("refuses a malformed or unsupported selection %#", async (selection) => {
    expect(await planDependencies(root(uvFiles()), "python", selection as never)).toBe(null);
  });

  it.each([undefined, "node", "cargo"])("refuses selection on tool %s rather than ignoring it", async (tool) => {
    expect(await planDependencies(root(uvFiles()), tool, testSelection)).toBe(null);
  });

  it("never selects pip or an ambiguous Python lock and keeps Node ambiguity scoped", async () => {
    const pinned = "pytest==9.2.0 --hash=sha256:abc123\n";
    expect(await planDependencies(root({ "requirements.txt": pinned }), "python", testSelection)).toBe(null);
    expect(await planDependencies(root({ ...uvFiles(), "requirements.txt": pinned }), "python", testSelection)).toBe(null);
    expect(await planDependencies(root({ ...uvFiles(), "requirements.txt": "pytest\n", "package-lock.json": "x", "yarn.lock": "x" }), "python", testSelection)).not.toBe(null);
  });

  it.each([
    ["missing manifest", { "uv.lock": uvLock }],
    ["missing lock", { "pyproject.toml": uvManifest }],
    ["malformed manifest", { ...uvFiles(), "pyproject.toml": uvManifest + "bad = [" }],
    ["duplicate table", { ...uvFiles(), "pyproject.toml": uvManifest + "[project.optional-dependencies]\ntest=[]" }],
    ["undeclared test", { ...uvFiles(), "pyproject.toml": uvManifest.replace('test = ["pytest>=7"]', 'other = ["pytest>=7"]') }],
    ["URL requirement", { ...uvFiles(), "pyproject.toml": uvManifest.replace("pytest>=7", "pytest @ https://example.com/pkg.whl") }],
    ["nested dependency extra", { ...uvFiles(), "pyproject.toml": uvManifest.replace("pytest>=7", "pytest[more]>=7") }],
    ["empty extra", { ...uvFiles(), "pyproject.toml": uvManifest.replace('["pytest>=7"]', "[]") }],
    ["unlocked test", { ...uvFiles(), "uv.lock": uvLock.replace('test = [{ name = "pytest" }]', 'test = []') }],
    ["missing target", { ...uvFiles(), "uv.lock": uvLock.replace('name = "pytest"\nversion = "9.2.0"', 'name = "other"\nversion = "9.2.0"') }],
    ["ambiguous test target", { ...uvFiles(), "uv.lock": uvLock + '[[package]]\nname="pytest"\nversion="9.1.0"\nsource={registry="https://pypi.org/simple"}\n' }],
    ["conditional test edge", { ...uvFiles(), "uv.lock": uvLock.replace('test = [{ name = "pytest" }]', `test = [{ name = "pytest", marker = "sys_platform == 'win32'" }]`) }],
    ["malformed test edge marker", { ...uvFiles(), "uv.lock": uvLock.replace('test = [{ name = "pytest" }]', 'test = [{ name = "pytest", marker = 7 }]') }],
    ["compound test metadata marker", { ...uvFiles(), "uv.lock": uvLock.replace("extra == 'test'", "extra == 'test' and python_version >= '3.11'") }],
    ["missing provided test extra", { ...uvFiles(), "uv.lock": uvLock.replace('provides-extras = ["api", "test"]', 'provides-extras = ["api"]') }],
    ["edge version mismatch", { ...uvFiles(), "uv.lock": uvLock.replace('test = [{ name = "pytest" }]', 'test = [{ name = "pytest", version = "8.0.0" }]') }],
    ["dynamic project metadata", { ...uvFiles(), "pyproject.toml": uvManifest.replace('version = "0.1.0"', 'version = "0.1.0"\ndynamic = ["dependencies"]') }],
    ["stale requirement", { ...uvFiles(), "pyproject.toml": uvManifest.replace("pytest>=7", "pytest>=8") }],
    ["stale project version", { ...uvFiles(), "pyproject.toml": uvManifest.replace("0.1.0", "0.2.0") }],
    ["extra alias collision", { ...uvFiles(), "pyproject.toml": uvManifest + 'TEST = ["pytest>=7"]\n' }],
    ["workspace", { ...uvFiles(), "pyproject.toml": uvManifest + '[tool.uv.workspace]\nmembers=["sub"]\n' }],
    ["source override", { ...uvFiles(), "pyproject.toml": uvManifest + '[tool.uv.sources]\npytest={path="sub"}\n' }],
    ["malformed lock", { ...uvFiles(), "uv.lock": uvLock + "broken=[" }],
    ["wrong lock version", { ...uvFiles(), "uv.lock": uvLock.replace("version = 1\n", "version = 2\n") }],
    ["ambiguous roots", { ...uvFiles(), "uv.lock": uvLock + '[[package]]\nname="another"\nsource={virtual="."}\n' }],
    ["nested local project", { ...uvFiles(), "uv.lock": uvLock.replace('name = "client"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }', 'name = "client"\nversion = "1.0.0"\nsource = { editable = "sub" }') }],
  ] satisfies Array<[string, Record<string, string>]>) ("refuses %s", async (_reason, files) => {
    expect(await planDependencies(root(files), "python", testSelection)).toBe(null);
  });

  it.each(["uv.lock", "requirements.txt", "pyproject.toml"])("refuses a nested %s", async (file) => {
    const dir = root({ ...uvFiles(), [`sub/${file}`]: "anything", "sub/tests/case.py": "" });
    expect(await planDependencies(dir, "python", { ...testSelection, cwdRelative: "sub/tests" })).toBe(null);
  });

  it.each(["pyproject.toml", "uv.lock", "requirements.txt"])("refuses symlinked, directory and oversized %s", async (file) => {
    const dir = root(uvFiles());
    rmSync(path.join(dir, file), { force: true });
    symlinkSync(path.join(dir, "missing"), path.join(dir, file));
    expect(await planDependencies(dir, "python", testSelection)).toBe(null);
    rmSync(path.join(dir, file));
    mkdirSync(path.join(dir, file));
    expect(await planDependencies(dir, "python", testSelection)).toBe(null);
    rmSync(path.join(dir, file), { recursive: true });
    writeFileSync(path.join(dir, file), "");
    truncateSync(path.join(dir, file), 33 * 1024 * 1024);
    expect(await planDependencies(dir, "python", testSelection)).toBe(null);
  });

  it("refuses invalid UTF-8, FIFOs, missing cwd and symlinked prefixes without following them", async () => {
    const dir = root(uvFiles());
    writeFileSync(path.join(dir, "pyproject.toml"), Buffer.from([0xff]));
    expect(await planDependencies(dir, "python", testSelection)).toBe(null);
    writeFileSync(path.join(dir, "pyproject.toml"), uvManifest);
    rmSync(path.join(dir, "uv.lock"));
    execFileSync("mkfifo", [path.join(dir, "uv.lock")]);
    expect(await planDependencies(dir, "python", testSelection)).toBe(null);
    rmSync(path.join(dir, "uv.lock"));
    writeFileSync(path.join(dir, "uv.lock"), uvLock);
    expect(await planDependencies(dir, "python", { ...testSelection, cwdRelative: "missing" })).toBe(null);
    symlinkSync(root({ "unit/case.py": "" }), path.join(dir, "tests"));
    expect(await planDependencies(dir, "python", { ...testSelection, cwdRelative: "tests/unit" })).toBe(null);
  });
});

describe("nestedLockfile", () => {
  it("finds a lockfile between the run directory and the root, never the root's own", async () => {
    const dir = root({ "package-lock.json": "{}", "packages/a/src/x.ts": "", "tools/b/package-lock.json": "{}", "py/c/uv.lock": "x" });
    expect(await nestedLockfile(dir, ".", "node")).toBe(null);
    expect(await nestedLockfile(dir, "packages/a/src", "node")).toBe(null);
    expect(await nestedLockfile(dir, "tools/b", "node")).toBe("tools/b/package-lock.json");
    expect(await nestedLockfile(dir, "py/c", "node")).toBe(null);
    expect(await nestedLockfile(dir, "py/c", "python")).toBe("py/c/uv.lock");
  });
});
