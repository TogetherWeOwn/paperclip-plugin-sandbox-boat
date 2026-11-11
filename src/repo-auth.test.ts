import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authenticateRepoInner, isAuthenticatableRemoteUrl, type GitRunner } from "./repo-auth.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const PUBLIC = "https://github.com/example/public";

function blobOid(content: string): string {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
}

function treeLine(mode: string, type: string, oid: string, rel: string): string {
  return `${mode} ${type} ${oid}\t${rel}`;
}

function runnerWith(opts: {
  remote?: string;
  remoteExit?: number;
  head?: string;
  headExit?: number;
  catType?: string;
  catExit?: number;
  tree?: string;
  treeExit?: number;
  index?: string;
  indexExit?: number;
}): GitRunner {
  return async (args) => {
    if (args.includes("ls-remote")) return { stdout: opts.remote ?? "", exit: opts.remoteExit ?? 0 };
    if (args.includes("rev-parse")) return { stdout: opts.head ?? "", exit: opts.headExit ?? 0 };
    if (args.includes("cat-file")) return { stdout: opts.catType ?? "commit\n", exit: opts.catExit ?? 0 };
    if (args.includes("ls-tree")) return { stdout: opts.tree ?? "", exit: opts.treeExit ?? 0 };
    if (args.includes("ls-files")) return { stdout: opts.index ?? "", exit: opts.indexExit ?? 0 };
    return { stdout: "", exit: 128 };
  };
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

describe("authenticateRepoInner", () => {
  it("accepts a genuine HEAD advertised by the remote with matching raw bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const tree = `${treeLine("100644", "blob", blobOid(content), "file.txt")}\0`;
      const runner = runnerWith({ remote: `${HEAD}\tHEAD\n${HEAD}\trefs/heads/main\n`, head: `${HEAD}\n`,
        tree, index: "file.txt\0" });
      expect(await authenticateRepoInner(PUBLIC, dir, runner)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a symlink whose target string hashes to its blob", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      await symlink("target.txt", path.join(dir, "link"));
      const target = "target.txt";
      const tree = `${treeLine("120000", "blob", blobOid(target), "link")}\0`;
      const runner = runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, tree, index: "link\0" });
      expect(await authenticateRepoInner(PUBLIC, dir, runner)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a checkout whose HEAD is not advertised by the remote", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const tree = `${treeLine("100644", "blob", blobOid(content), "file.txt")}\0`;
      const runner = runnerWith({ remote: `${OTHER}\trefs/heads/main\n`, head: `${HEAD}\n`, tree, index: "file.txt\0" });
      expect(await authenticateRepoInner(PUBLIC, dir, runner)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses when ls-remote fails (unreachable or private remote)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const tree = `${treeLine("100644", "blob", blobOid(content), "file.txt")}\0`;
      const index = "file.txt\0";
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remoteExit: 128, head: `${HEAD}\n`, tree, index }))).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: "", head: `${HEAD}\n`, tree, index }))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses when HEAD is missing, malformed, or not a commit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const tree = "";
      const index = "";
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, headExit: 128, tree, index }))).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, head: "short\n", tree, index }))).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, catType: "tree\n", tree, index }))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a dirty tree even when the index names the same paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      await writeFile(path.join(dir, "file.txt"), "private bytes\n");
      const tree = `${treeLine("100644", "blob", blobOid("hello\n"), "file.txt")}\0`;
      const runner = runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, tree, index: "file.txt\0" });
      expect(await authenticateRepoInner(PUBLIC, dir, runner)).toBe(false);
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
      const tree = `${treeLine("100644", "blob", blobOid(content), "file.txt")}\0`;
      const runner = runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, tree, index: "file.txt\0extra.txt\0" });
      expect(await authenticateRepoInner(PUBLIC, dir, runner)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing, malformed or unlistable tree/index", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-"));
    try {
      const content = "hello\n";
      await writeFile(path.join(dir, "file.txt"), content);
      const goodTree = `${treeLine("100644", "blob", blobOid(content), "file.txt")}\0`;
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, treeExit: 128, index: "file.txt\0" }))).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, tree: goodTree, indexExit: 128 }))).toBe(false);
      expect(await authenticateRepoInner(PUBLIC, dir,
        runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, tree: "not-a-tree-entry", index: "file.txt\0" }))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-https remotes without contacting them", async () => {
    let called = false;
    const runner: GitRunner = async () => { called = true; return { stdout: "", exit: 0 }; };
    expect(await authenticateRepoInner("file:///tmp/private", "/srv/work/repo", runner)).toBe(false);
    expect(await authenticateRepoInner("git@github.com:example/private", "/srv/work/repo", runner)).toBe(false);
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


  /** Real plumbing for local reads; ls-remote is faked to advertise `advertised`. */
  function realRunner(advertised: string): GitRunner {
    return async (args, opts) => {
      if (args.includes("ls-remote")) return { stdout: `${advertised}\tHEAD\n`, exit: 0 };
      try {
        const stdout = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", stdio: "pipe",
          env: { ...process.env } });
        return { stdout, exit: 0 };
      } catch (error) {
        return { stdout: "", exit: (error as { status?: number }).status ?? 128 };
      }
    };
  }

  it("accepts a genuine real checkout", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "boat-repo-auth-real-"));
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    try {
      const head = initRepo(repo, "file.txt", "hello\n");
      expect(await authenticateRepoInner(PUBLIC, repo, realRunner(head))).toBe(true);
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
      // The whole point of byte hashing: git itself reports clean here,
      // the private bytes are still on disk and would be synced.
      git(repo, "update-index", "--assume-unchanged", "file.txt");
      writeFileSync(path.join(repo, "file.txt"), "private bytes\n");
      expect(gitDiffIsClean(repo)).toBe(true);
      expect(await authenticateRepoInner(PUBLIC, repo, realRunner(head))).toBe(false);
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
      // Index/worktree carry the private bytes, HEAD names the public id.
      writeFileSync(path.join(repo, "file.txt"), "private bytes\n");
      git(repo, "add", "file.txt");
      git(repo, "replace", advertised, privateTree);
      expect(await authenticateRepoInner(PUBLIC, repo, realRunner(advertised))).toBe(false);
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
      expect(await authenticateRepoInner(PUBLIC, repo, realRunner(head))).toBe(false);
      expect(await pathExists(marker)).toBe(false);
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
