// Authenticated repository identity for the local-run offload allowlist.
//
// The workspace row's `repoUrl` and the checkout's on-disk
// `remote.origin.url` are both agent-writable: an agent that rewrites both
// to an allowlisted public repo can spoof the allowlist check that compares
// them, and the executor gate would then sync a private checkout's tracked
// source to pool VMs. Agreement of two agent-controlled strings is not a
// fact, so the allowlist also requires an authenticated remote fact:
//
//   - the claimed remote is contacted unauthenticated (`git ls-remote`)
//     and the checkout's HEAD commit is among its advertised refs, and
//   - the tracked worktree/index match that HEAD (a clean `git diff`),
//     so the bytes that would be synced are the bytes the remote
//     advertises.
//
// Any failure — unreachable remote, private/invalid remote, missing HEAD,
// dirty tree, timeout — fails closed: the caller stays local and never
// syncs. Only `https:` remotes are accepted: a local path or `file:` URL
// would let the agent point `ls-remote` at another local checkout and
// forge the proof, and an SSH URL would need credentials.
//
// The git invocations run with the agent checkout's configuration ignored
// (global/system config to /dev/null, hooks/fsmonitor off, terminal prompts
// off, protocol pinned to https), so a planted gitconfig cannot turn the
// check into code execution in the plugin worker.
import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitRunner = (
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: string; exit: number }>;

function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = "https";
  return env;
}

const HARDENED_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "credential.helper=",
];

function gitArgs(...rest: string[]): string[] {
  return [...HARDENED_GIT_CONFIG.flatMap((item) => ["-c", item]), ...rest];
}

function runGitReal(args: string[], opts: { cwd?: string }): Promise<{ stdout: string; exit: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { stdout: string; exit: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const child = spawn("git", args, { env: hardenedGitEnv(), cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ stdout: "", exit: 124 }), GIT_TIMEOUT_MS);
    let stdout = "";
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) {
        finish({ stdout: "", exit: 124 });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish({ stdout: "", exit: 128 }));
    child.on("close", (code, signal) => finish({ stdout, exit: code ?? (signal ? 128 : 0) }));
  });
}

function parseRemoteOids(stdout: string): Set<string> {
  const oids = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{4,64})\t/.exec(line.trim());
    if (match) oids.add(match[1]!);
  }
  return oids;
}

function parseHeadOid(stdout: string): string | null {
  const oid = stdout.trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Claimed remote must be a plain https URL with no credentials. */
export function isAuthenticatableRemoteUrl(repoUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  return true;
}

/**
 * Totally unauthenticated proof that the checkout's HEAD is served by the
 * claimed remote and the synced tree matches it. Test seam: inject
 * `runGit`; production uses the real git runner. Every failure returns
 * false — the caller must stay local.
 */
export async function authenticateRepoInner(
  repoUrl: string,
  localPath: string,
  runGit: GitRunner = runGitReal,
): Promise<boolean> {
  if (!isAuthenticatableRemoteUrl(repoUrl)) return false;
  const claimed = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  // Local HEAD first so a non-repository fails fast without any network
  // contact; the remote only confirms a HEAD the checkout already has.
  let head: { stdout: string; exit: number };
  try {
    head = await runGit(gitArgs("-C", localPath, "rev-parse", "--verify", "HEAD"), {});
  } catch {
    return false;
  }
  const headOid = head.exit === 0 ? parseHeadOid(head.stdout) : null;
  if (!headOid) return false;
  let remote: { stdout: string; exit: number };
  try {
    remote = await runGit(gitArgs("ls-remote", "--", claimed), {});
  } catch {
    return false;
  }
  if (remote.exit !== 0) return false;
  const advertised = parseRemoteOids(remote.stdout);
  if (advertised.size === 0) return false;
  if (!advertised.has(headOid)) return false;
  // The synced bytes are the worktree files, not the commit object: a HEAD
  // that matches the remote but uncommitted edits that do not would still
  // leak. Require a clean tree against the authenticated HEAD.
  for (const args of [["diff", "--quiet", "HEAD"], ["diff", "--cached", "--quiet", "HEAD"]] as const) {
    let diff: { exit: number };
    try {
      diff = await runGit(gitArgs("-C", localPath, ...args), {});
    } catch {
      return false;
    }
    if (diff.exit !== 0) return false;
  }
  return true;
}

type RepoAuthOverride = (repoUrl: string, localPath: string) => Promise<boolean>;
let override: RepoAuthOverride | null = null;

/** Test hook, mirroring setBoatApiFactoryForTests. Production never sets this. */
export function setRepoAuthForTests(fn: RepoAuthOverride | null): void {
  override = fn;
}

export async function authenticateRepo(repoUrl: string, localPath: string): Promise<boolean> {
  if (override) return override(repoUrl, localPath);
  return authenticateRepoInner(repoUrl, localPath);
}
