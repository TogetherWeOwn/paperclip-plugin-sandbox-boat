import { describe, expect, it } from "vitest";
import { authenticateRepoInner, isAuthenticatableRemoteUrl, type GitRunner } from "./repo-auth.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const PUBLIC = "https://github.com/example/public";

function runnerWith(opts: {
  remote?: string;
  remoteExit?: number;
  head?: string;
  headExit?: number;
  diffExit?: number;
}): GitRunner {
  return async (args) => {
    if (args.includes("ls-remote")) return { stdout: opts.remote ?? "", exit: opts.remoteExit ?? 0 };
    if (args.includes("rev-parse")) return { stdout: opts.head ?? "", exit: opts.headExit ?? 0 };
    if (args.includes("diff")) return { stdout: "", exit: opts.diffExit ?? 0 };
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
  it("accepts a genuine HEAD advertised by the remote with a clean tree", async () => {
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: `${HEAD}\tHEAD\n${HEAD}\trefs/heads/main\n`, head: `${HEAD}\n`, diffExit: 0 }))).toBe(true);
  });

  it("refuses a spoofed checkout whose HEAD is not advertised by the remote", async () => {
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: `${OTHER}\trefs/heads/main\n`, head: `${HEAD}\n`, diffExit: 0 }))).toBe(false);
  });

  it("refuses when ls-remote fails (unreachable or private remote)", async () => {
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remoteExit: 128, head: `${HEAD}\n`, diffExit: 0 }))).toBe(false);
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: "", head: `${HEAD}\n`, diffExit: 0 }))).toBe(false);
  });

  it("refuses when HEAD is missing or malformed", async () => {
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: `${HEAD}\tHEAD\n`, headExit: 128, diffExit: 0 }))).toBe(false);
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: `${HEAD}\tHEAD\n`, head: "short\n", diffExit: 0 }))).toBe(false);
  });

  it("refuses a dirty tree against the authenticated HEAD", async () => {
    expect(await authenticateRepoInner(PUBLIC, "/srv/work/repo",
      runnerWith({ remote: `${HEAD}\tHEAD\n`, head: `${HEAD}\n`, diffExit: 1 }))).toBe(false);
  });

  it("rejects non-https remotes without contacting them", async () => {
    let called = false;
    const runner: GitRunner = async () => { called = true; return { stdout: "", exit: 0 }; };
    expect(await authenticateRepoInner("file:///tmp/private", "/srv/work/repo", runner)).toBe(false);
    expect(await authenticateRepoInner("git@github.com:example/private", "/srv/work/repo", runner)).toBe(false);
    expect(called).toBe(false);
  });
});
