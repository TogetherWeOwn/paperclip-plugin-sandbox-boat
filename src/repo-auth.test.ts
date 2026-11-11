import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authenticateRepoInner,
  HARDENED_GIT_CONFIG,
  hardenedGitEnv,
  isAuthenticatableRemoteUrl,
  type GitRunner,
  type GitRunnerRaw,
} from "./repo-auth.js";

const PUBLIC = "https://github.com/example/public";

function blobOid(content: string): string {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
}

function hashObject(type: "commit" | "tree", content: Buffer): string {
  return createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex");
}

function makeTreeRaw(entries: { mode: string; name: string; oid: string }[]): Buffer {
  return Buffer.concat(
    entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")])),
  );
}

function makeCommitRaw(treeOid: string): Buffer {
  return Buffer.from(
    `tree ${treeOid}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\ntest\n`,
  );
}

interface FakeOpts {
  head?: string;
  headExit?: number;
  commitRaw?: Buffer;
  commitExit?: number;
  treeRawByOid?: Map<string, Buffer>;
  treeExit?: number;
  index?: string;
  indexExit?: number;
  remote?: string;
  remoteExit?: number;
}

function fakeRunners(opts: FakeOpts): { runGit: GitRunner; runGitRaw: GitRunnerRaw } {
  const runGit: GitRunner = async (args) => {
    if (args.includes("ls-remote")) return { stdout: opts.remote ?? "", exit: opts.remoteExit ?? 0 };
    if (args.includes("rev-parse")) return { stdout: opts.head ?? "", exit: opts.headExit ?? 0 };
    if (args.includes("ls-files")) return { stdout: opts.index ?? "", exit: opts.indexExit ?? 0 };
    return { stdout: "", exit: 128 };
  };
  const runGitRaw: GitRunnerRaw = async (args) => {
    if (args.includes("commit")) {
      if ((opts.commitExit ?? 0) !== 0) return { stdout: Buffer.alloc(0), exit: opts.commitExit! };
      return { stdout: opts.commitRaw ?? Buffer.alloc(0), exit: 0 };
    }
    if (args.includes("tree")) {
      if ((opts.treeExit ?? 0) !== 0) return { stdout: Buffer.alloc(0), exit: opts.treeExit! };
      const oid = args.at(-1) ?? "";
      const raw = opts.treeRawByOid?.get(oid);
      return raw ? { stdout: raw, exit: 0 } : { stdout: Buffer.alloc(0), exit: 128 };
    }
    return { stdout: Buffer.alloc(0), exit: 128 };
  };
  return { runGit, runGitRaw };
}

/** Build a genuine single-tree chain: file.txt -> blob -> tree -> commit -> HEAD. */
function genuineChain(content: string) {
  const blob = blobOid(content);
  const treeRaw = makeTreeRaw([{ mode: "100644", name: "file.txt", oid: blob }]);
  const treeOid = hashObject("tree", treeRaw);
  const commitRaw = makeCommitRaw(treeOid);
  const head = hashObject("commit", commitRaw);
  return { blob, treeRaw, treeOid, commitRaw, head };
}

describe("isAuthenticatableRemoteUrl", () => {
  it.each([PUBLIC, "https://github.com/example/public.git", "https://example.com/repo"])("accepts %s", (url) => {
    expect(isAuthenticatableRemoteUrl(url)).toBe(true);
  });
  it.each([
    "http://github.com/example/public", "ssh://git@github.com/example/public", "git@github.com:example/public",
    "file:///tmp/other", "/tmp/other", "git://github.com/example/public", "https://user:pass@github.com/example/public",
    "", "not a url",
  ])("rejects %s", (url) => {
    expect(isAuthenticatableRemoteUrl(url)).toBe(false);
  });
});

describe("hardened git environment", () => {
  it("disables lazy fetching, askpass and ambient credentials", () => {
    const home = "/tmp/isolated-home-test";
    const env = hardenedGitEnv(home);
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.HOME).toBe(home);
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SUDO_ASKPASS).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(HARDENED_GIT_CONFIG).toContain("core.askPass=");
    expect(HARDENED_GIT_CONFIG).toContain("credential.helper=");
  });
});

describe("authenticateRepoInner", () => {
  it("accepts a genuine HEAD advertised by the remote with matching raw bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const c = genuineChain(content);
      const runners = fakeRunners({
        remote: `${c.head}\tHEAD\n${c.head}\trefs/heads/main\n`,
        head: `${c.head}\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "file.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a symlink whose target string hashes to its blob", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      await symlink("target.txt", path.join(dir, "link"));
      const target = "target.txt";
      const blob = blobOid(target);
      const treeRaw = makeTreeRaw([{ mode: "120000", name: "link", oid: blob }]);
      const treeOid = hashObject("tree", treeRaw);
      const commitRaw = makeCommitRaw(treeOid);
      const head = hashObject("commit", commitRaw);
      const runners = fakeRunners({
        remote: `${head}\tHEAD\n`,
        head: `${head}\n`,
        commitRaw,
        treeRawByOid: new Map([[treeOid, treeRaw]]),
        index: "link\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts nested subtrees whose objects hash-verify", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "sub", "file.txt"), content);
      const blob = blobOid(content);
      const subRaw = makeTreeRaw([{ mode: "100644", name: "file.txt", oid: blob }]);
      const subOid = hashObject("tree", subRaw);
      const rootRaw = makeTreeRaw([{ mode: "40000", name: "sub", oid: subOid }]);
      const rootOid = hashObject("tree", rootRaw);
      const commitRaw = makeCommitRaw(rootOid);
      const head = hashObject("commit", commitRaw);
      const runners = fakeRunners({
        remote: `${head}\tHEAD\n`,
        head: `${head}\n`,
        commitRaw,
        treeRawByOid: new Map([[rootOid, rootRaw], [subOid, subRaw]]),
        index: "sub/file.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a checkout whose HEAD is not advertised by the remote", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const c = genuineChain(content);
      const runners = fakeRunners({
        remote: `${"b".repeat(40)}\trefs/heads/main\n`,
        head: `${c.head}\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "file.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses when ls-remote fails (unreachable or private remote)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const c = genuineChain(content);
      const base = {
        head: `${c.head}\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "file.txt\0",
      };
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({ ...base, remoteExit: 128 })) as [never, never])).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({ ...base, remote: "" })) as [never, never])).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses when HEAD is missing or malformed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const c = genuineChain("hello\n");
      const base = {
        remote: `${c.head}\tHEAD\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "",
      };
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({ ...base, headExit: 128 })) as [never, never])).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({ ...base, head: "short\n" })) as [never, never])).toBe(false);
      // Commit raw whose hash does not match the advertised HEAD oid.
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({
          ...base, head: `${"a".repeat(40)}\n`, commitRaw: c.commitRaw,
          remote: `${"a".repeat(40)}\tHEAD\n`,
        })) as [never, never])).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({ ...base, head: `${c.head}\n`, commitExit: 128 })) as [never, never])).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a counterfeit tree whose contents do not hash to its oid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "private bytes\n";
      await writeFile(path.join(dir, "file.txt"), content);
      // Commit references a tree oid, but the object fetched for that oid is
      // a different tree (hash mismatch): a forged loose object under the
      // advertised id must be refused.
      const genuine = genuineChain("hello\n");
      const fakeTreeRaw = makeTreeRaw([{ mode: "100644", name: "file.txt", oid: blobOid(content) }]);
      const runners = fakeRunners({
        remote: `${genuine.head}\tHEAD\n`,
        head: `${genuine.head}\n`,
        commitRaw: genuine.commitRaw,
        treeRawByOid: new Map([[genuine.treeOid, fakeTreeRaw]]),
        index: "file.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses commits containing a gitlink instead of syncing its index path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      // Worktree has a regular file at the gitlink path with private bytes;
      // path-set equality alone used to let this bind because gitlink
      // entries were skipped during byte verification.
      await writeFile(path.join(dir, "lib"), "private bytes\n");
      const gitlinkOid = "b".repeat(40);
      const treeRaw = makeTreeRaw([{ mode: "160000", name: "lib", oid: gitlinkOid }]);
      const treeOid = hashObject("tree", treeRaw);
      const commitRaw = makeCommitRaw(treeOid);
      const head = hashObject("commit", commitRaw);
      const runners = fakeRunners({
        remote: `${head}\tHEAD\n`,
        head: `${head}\n`,
        commitRaw,
        treeRawByOid: new Map([[treeOid, treeRaw]]),
        index: "lib\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a dirty tree even when the index names the same paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      await writeFile(path.join(dir, "file.txt"), "private bytes\n");
      const c = genuineChain("hello\n");
      const runners = fakeRunners({
        remote: `${c.head}\tHEAD\n`,
        head: `${c.head}\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "file.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a staged extra file that is not in the HEAD tree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      await writeFile(path.join(dir, "extra.txt"), content);
      const c = genuineChain(content);
      const runners = fakeRunners({
        remote: `${c.head}\tHEAD\n`,
        head: `${c.head}\n`,
        commitRaw: c.commitRaw,
        treeRawByOid: new Map([[c.treeOid, c.treeRaw]]),
        index: "file.txt\0extra.txt\0",
      });
      expect(await authenticateRepoInner(PUBLIC, dir, runners.runGit, runners.runGitRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing, malformed or unlistable tree/index", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const c = genuineChain(content);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({
          remote: `${c.head}\tHEAD\n`, head: `${c.head}\n`, commitRaw: c.commitRaw,
          treeRawByOid: new Map([[c.treeOid, c.treeRaw]]), treeExit: 128, index: "file.txt\0",
        })) as [never, never])).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({
          remote: `${c.head}\tHEAD\n`, head: `${c.head}\n`, commitRaw: c.commitRaw,
          treeRawByOid: new Map([[c.treeOid, c.treeRaw]]), indexExit: 128,
        })) as [never, never])).toBe(false);
      // Tree raw whose hash matches its oid but whose body is not a tree.
      const badTree = Buffer.from("not-a-tree\n");
      const badTreeOid = hashObject("tree", badTree);
      const badCommit = makeCommitRaw(badTreeOid);
      const badHead = hashObject("commit", badCommit);
      expect(await authenticateRepoInner(PUBLIC, dir,
        ...Object.values(fakeRunners({
          remote: `${badHead}\tHEAD\n`, head: `${badHead}\n`, commitRaw: badCommit,
          treeRawByOid: new Map([[badTreeOid, badTree]]), index: "file.txt\0",
        })) as [never, never])).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-https remotes without contacting them", async () => {
    let called = false;
    const runner: GitRunner = async () => { called = true; return { stdout: "", exit: 0 }; };
    const raw: GitRunnerRaw = async () => { called = true; return { stdout: Buffer.alloc(0), exit: 0 }; };
    expect(await authenticateRepoInner("file:///tmp/private", "/srv/work/repo", runner, raw)).toBe(false);
    expect(await authenticateRepoInner("git@github.com:example/private", "/srv/work/repo", runner, raw)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("authenticateRepoInner with real local git", () => {
  function git(repo: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env } });
  }

  function initRepo(repo: string, file: string, content: string): string {
    execFileSync("git", ["init", "-q", repo]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(path.join(repo, file), content);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", "initial");
    return git(repo, "rev-parse", "HEAD").trim();
  }

  function realRunners(advertised: string): { runGit: GitRunner; runGitRaw: GitRunnerRaw } {
    const runGit: GitRunner = async (args, opts) => {
      if (args.includes("ls-remote")) return { stdout: `${advertised}\tHEAD\n`, exit: 0 };
      try {
        const stdout = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", stdio: "pipe",
          env: { ...process.env } });
        return { stdout, exit: 0 };
      } catch (error) {
        return { stdout: "", exit: (error as { status?: number }).status ?? 128 };
      }
    };
    const runGitRaw: GitRunnerRaw = async (args, opts) => {
      if (args.includes("ls-remote")) return { stdout: Buffer.from(`${advertised}\tHEAD\n`), exit: 0 };
      try {
        const stdout = execFileSync("git", args, { cwd: opts.cwd, stdio: "pipe", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env } });
        return { stdout: stdout as Buffer, exit: 0 };
      } catch (error) {
        return { stdout: Buffer.alloc(0), exit: (error as { status?: number }).status ?? 128 };
      }
    };
    return { runGit, runGitRaw };
  }

  it("accepts a genuine real checkout", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      const r = realRunners(head);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses an assume-unchanged file whose bytes were replaced", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      git(repo, "update-index", "--assume-unchanged", "file.txt");
      writeFileSync(path.join(repo, "file.txt"), "private bytes\n");
      expect(gitDiffIsClean(repo)).toBe(true);
      const r = realRunners(head);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses a replaced commit with a private tree under the advertised id", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const advertised = initRepo(repo, "file.txt", "hello\n");
      git(repo, "checkout", "-q", "-b", "private");
      writeFileSync(path.join(repo, "file.txt"), "private bytes\n");
      git(repo, "add", "file.txt");
      git(repo, "commit", "-q", "-m", "private");
      const privateTree = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "--detach", advertised);
      writeFileSync(path.join(repo, "file.txt"), "private bytes\n");
      git(repo, "add", "file.txt");
      git(repo, "replace", advertised, privateTree);
      const r = realRunners(advertised);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never executes a checkout-configured clean filter", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      const marker = path.join(base, "filter-marker");
      await writeFile(path.join(repo, ".git", "info", "attributes"), "*.txt filter=evil\n");
      git(repo, "config", "filter.evil.clean", `sh -c 'cat; touch ${marker}'`);
      writeFileSync(path.join(repo, "file.txt"), "dirty\n");
      const r = realRunners(head);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(false);
      expect(await pathExists(marker)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses a checkout whose commit contains a gitlink", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      // Replace the tracked file with a gitlink entry in a new commit.
      const gitlinkOid = "b".repeat(40);
      git(repo, "update-index", "--force-remove", "file.txt");
      git(repo, "update-index", "--add", "--cacheinfo", `160000,${gitlinkOid},file.txt`);
      git(repo, "commit", "-q", "-m", "gitlink");
      const gitlinkHead = git(repo, "rev-parse", "HEAD").trim();
      // HEAD now advertises a gitlink at file.txt: it must stay local even
      // though the index path is unchanged in shape.
      const r = realRunners(gitlinkHead);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses a forged loose object stored under the advertised id", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      const treeOid = git(repo, "rev-parse", "HEAD^{tree}").trim();
      // Overwrite the loose tree object with a different (private) tree
      // containing private blob oids. The proof must not trust it.
      const privContent = "private bytes\n";
      const privBlob = blobOid(privContent);
      // Write the private blob loose object so ls-tree (if it were used)
      // would list it.
      {
        const zlib = await import("node:zlib");
        const d = path.join(repo, ".git", "objects", privBlob.slice(0, 2));
        await mkdir(d, { recursive: true });
        const data = Buffer.concat([Buffer.from(`blob ${privContent.length}\0`), Buffer.from(privContent)]);
        writeFileSync(path.join(d, privBlob.slice(2)), zlib.deflateSync(data));
        const fakeTreeRaw = Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(privBlob, "hex")]);
        const fake = Buffer.concat([Buffer.from(`tree ${fakeTreeRaw.length}\0`), fakeTreeRaw]);
        const td = path.join(repo, ".git", "objects", treeOid.slice(0, 2));
        await chmod(path.join(td, treeOid.slice(2)), 0o644).catch(() => undefined);
        writeFileSync(path.join(td, treeOid.slice(2)), zlib.deflateSync(fake));
      }
      writeFileSync(path.join(repo, "file.txt"), privContent);
      git(repo, "add", "file.txt");
      const r = realRunners(head);
      expect(await authenticateRepoInner(PUBLIC, repo, r.runGit, r.runGitRaw)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  function gitDiffIsClean(repo: string): boolean {
    try {
      git(repo, "diff", "--quiet", "HEAD");
      git(repo, "diff", "--cached", "--quiet", "HEAD");
      return true;
    } catch {
      return false;
    }
  }

  async function pathExists(file: string): Promise<boolean> {
    return lstat(file).then(() => true, () => false);
  }
});
