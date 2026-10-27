// Default-deny run environment. Paperclip hands a sandbox provider the whole
// run env: the agent's env, the environment's envVars, every project and
// routine env binding with its secrets resolved, and, for some probe commands,
// the Paperclip server's own process env. Nothing upstream filters it for a
// sandbox. So this plugin delivers to the VM only the keys an allowlist names,
// and drops everything else. Dropped keys are reported by name only.
//
// The rules, in order, for each `NAME=value` the host passes:
//   1. The name must match the allowlist: an exact name, or a `NAME_*` prefix.
//   2. Never delivered, even when the allowlist names it exactly:
//      - names in the provider families PLANETSCALE_, CLOUDFLARE_, CF_,
//        DISCORD_, GH_, GITHUB_, BOAT_ and ASCII_;
//      - a value with a JWT in it anywhere (a host-verifiable bearer
//        credential, such as Paperclip's run token), also behind "Bearer " or
//        inside JSON (JSON escapes decoded);
//      - a value with anything URL-like in it (`scheme://`, also JSON-escaped
//        or percent-encoded, or a `user:password@`) that is not, as a whole,
//        one URL in unambiguous characters, or JSON whose every URL-like string
//        is one. A URL that parses is never proof that the text around it is
//        safe;
//      - a database URL, or a URL with credentials (a user, a password or a
//        credential query parameter), unless its effective destination is the
//        VM itself: the literal host localhost, 127.0.0.1 or [::1], an empty
//        host or a unix socket path, and no query parameter that names another
//        endpoint (libpq's host, hostaddr, service, ...; a host or socket of
//        absolute paths is a socket). No other IP spelling and no one-label
//        name counts: a resolver reads 0xc0000214 as 192.0.2.20, and a DNS
//        search domain can take a one-label name off the VM. A
//        `..._DATABASE_URL` or `..._DB_URL` name (also _URI, _DSN) counts as a
//        database URL whatever its value, so it must be one such URL.
//   3. Delivered only when the allowlist names it exactly, never through a
//      prefix: a name with TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE,
//      PRIVATE_KEY, API_KEY, APIKEY, ACCESS_KEY, CREDENTIAL, COOKIE, SIGNING,
//      HMAC or SALT in it, or ending in KEY (_KEY, or the whole name), _AUTH or
//      _PAT, and a VM-local database URL or URL with credentials. A `..._TOKENS`
//      name with a whole-number value is a token budget
//      (CLAUDE_CODE_MAX_OUTPUT_TOKENS), not a credential.
//
//   4. Managed GitHub names are exclusive: each is delivered only in its one
//      expected shape, any other value is dropped whatever the allowlist says.
//      PAPERCLIP_GITHUB_BROKER_TOKEN, named exactly, only when it is the run's
//      own managed-GitHub capability (isRunGithubCapability), the one JWT let
//      through; a raw GitHub token or any other value is dropped. Paperclip's
//      `git`/`gh` launchers in the VM need it to push; it is not a GitHub token
//      and works only through the sandbox bridge while the run is live.
//      ZDOTDIR and BASH_ENV only as the launcher dir that leads PATH and its
//      `.bashrc` (isGithubLauncherShellValue).
//
// An empty allowlist (`envAllowlist: []`) delivers nothing.

/**
 * What a Claude Code run needs to work through Paperclip's sandbox bridge and
 * this plugin's reverse tunnel to the model proxy. Each PAPERCLIP_* name was
 * checked in Paperclip's claude-local adapter and adapter-utils (tog.22):
 * ids, paths, modes and the per-run bridge credentials. Nothing here is a
 * long-lived host secret.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  // Model proxy: 127.0.0.1:<tunnelRemotePort> in the VM is the reverse tunnel.
  "ANTHROPIC_BASE_URL",
  // The dedicated model-proxy key of the sandbox environment. The only TOKEN
  // name a model needs; any other *TOKEN* name is dropped.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_*",
  // Claude Code tuning. CLAUDE_CODE_OAUTH_TOKEN still matches TOKEN and is
  // dropped: a prefix never delivers a secret-looking name.
  "CLAUDE_CODE_*",
  "CLAUDE_CONFIG_DIR",
  "API_TIMEOUT_MS",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "MAX_THINKING_TOKENS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_TELEMETRY",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "IS_SANDBOX",
  // Paperclip run context: ids, modes and paths (no secrets).
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_ISSUE_WORK_MODE",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
  "PAPERCLIP_WORKSPACES_JSON",
  "AGENT_HOME",
  // Paperclip's sandbox callback bridge. In a sandbox run PAPERCLIP_API_KEY is
  // the bridge token, a random per-run value that only the bridge inside this
  // VM accepts. Before the bridge starts it holds the run JWT instead, which
  // the JWT rule drops. The ACP process-session variables
  // (PAPERCLIP_PROCESS_SESSION_COMMAND_B64, PAPERCLIP_PROCESS_SESSION_DIR) are
  // not here: that launcher is refused (isAcpProcessSessionCommand below).
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_BRIDGE_MODE",
  "PAPERCLIP_BRIDGE_TOKEN",
  "PAPERCLIP_BRIDGE_*",
  "PAPERCLIP_SANDBOX_EXEC_CHANNEL",
  // Managed GitHub: the run-scoped capability that Paperclip's git/gh launchers
  // (staged in the VM, first on PATH) present to the broker through the bridge
  // above. Delivered only when it is this run's github_credentials capability
  // (isRunGithubCapability). PAPERCLIP_GITHUB_BROKER_URL is deliberately absent:
  // it names the controller, which the VM cannot reach, and without it the
  // launcher falls back to PAPERCLIP_API_URL, the bridge. ZDOTDIR and BASH_ENV
  // point zsh and bash at the launcher's profiles, which put the launcher dir
  // back first on PATH in nested and login shells (prepareGitHubOperationLaunchers);
  // delivered only as that VM dir, the one PATH starts with. The launcher sets
  // GIT_*, SSH_* and GH_CONFIG_DIR itself for each operation.
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "ZDOTDIR",
  "BASH_ENV",
  // Shell basics.
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "LC_*",
  "TZ",
];

/** Never delivered, not even when the allowlist names them exactly. */
const DENIED_NAME_PREFIXES = ["PLANETSCALE_", "CLOUDFLARE_", "CF_", "DISCORD_", "GH_", "GITHUB_", "BOAT_", "ASCII_"] as const;

const SECRET_NAME_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|CREDENTIAL|COOKIE|(?:^|_)KEY$|SIGNING|HMAC|SALT|_AUTH$|_PAT$/i;
const TOKEN_BUDGET_NAME_RE = /TOKENS$/i;
const WHOLE_NUMBER_RE = /^\d+$/;
// Every value pattern below runs in time linear in the value: the host passes
// values of any size, and a pattern that backtracks over a long run (an
// unanchored `X+\.` tried from every offset of `eyJeyJeyJ...` or `aaaa...`)
// takes seconds on a few hundred KB. A JWT anywhere in the value is found by a
// scan (containsJwtInText); the anchored form also catches a whole-value JWT
// whose payload does not start with `{"`. Anchored at the start, it tries one
// offset only, and its runs are split by literal dots, so it backtracks
// over each run at most once.
const JWT_WHOLE_VALUE_RE = /^(?:[Bb]earer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const DATABASE_SCHEME_RE =
  /^(?:postgres(?:ql)?|mysql2?|mariadb|mongodb(?:\+srv)?|rediss?|libsql|sqlserver|mssql|cockroachdb|clickhouse|amqps?|prisma(?:\+postgres)?)(?:\+[a-z0-9]+)?$/i;
const DATABASE_NAME_RE = /(?:^|_)(?:DATABASE|DB)(?:_|$)/i;
const URL_NAME_RE = /(?:_URL|_URI|_DSN|^DSN)$/i;
// Anything URL-like in a text. Each pattern is linear in the text (fixed-length
// alternatives, or a run that stops at the next `:`), so a large value cannot
// make them backtrack. A value that matches one is kept only when it is, as a
// whole, one URL that is safe (inspectValue).
const URL_LIKE_RES: readonly RegExp[] = [
  // A scheme separator `://`, also JSON-escaped (`:\/\/`, `/`) or percent-encoded.
  /(?::|%3a|\\u003a)(?:\\?\/|%2f|\\u002f){2}/i,
  // `user:password@` with or without a scheme: a `:`, then an `@` before any space, `/` or other `:`.
  /:[^\s/@:]*@/,
];
// One whole URL, in characters every URL parser reads the same way: no space
// or control character, no quote, backslash, `<>`, backtick, `{}`, `|` or `^`.
const WHOLE_URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([A-Za-z0-9\-._~!$&()*+,;=:@%[\]]*)((?:[/?#][A-Za-z0-9\-._~!$&()*+,;=:@%[\]/?#]*)?)$/;
// The only hosts that are the VM itself to every parser and resolver: literal loopback.
const LOOPBACK_HOSTPORT_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
// Query parameters that change where a client connects (libpq host/hostaddr/service, a socket, a server, a proxy).
const ENDPOINT_PARAM_RE = /host|addr|server|service|socket|proxy|dsn|url|uri|endpoint/i;
// Of those, the ones that name a unix socket when their value is an absolute path.
const SOCKET_PARAM_RE = /^(?:host|socket)$/i;
// Query parameters that carry a credential.
const CREDENTIAL_PARAM_RE = /pass|pwd|token|secret|key|auth|cred|signature|^sig$|session|jwt|bearer/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWLIST_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:_\*)?$/;

export type EnvDropReason =
  | "not_allowlisted"
  | "denied_family"
  | "jwt"
  | "remote_database_or_credential_url"
  | "secret_name_needs_exact_entry"
  | "github_capability_rejected"
  | "github_launcher_mismatch"
  | "invalid_name";

export interface EnvDrop {
  /** The variable name; `(invalid name)` when it is not a valid shell name. Never the value. */
  name: string;
  reason: EnvDropReason;
}

export interface EnvFilterResult {
  kept: Array<[string, string]>;
  dropped: EnvDrop[];
}

interface CompiledAllowlist {
  exact: Set<string>;
  prefixes: string[];
}

/**
 * Read `envAllowlist` from config: a list, or one string split on commas,
 * spaces or newlines. Null when unset (the built-in list applies). A list, even
 * an empty one, is used as it is: `[]` delivers nothing. A blank string counts
 * as unset, because a form field that was left empty sends one.
 */
export function parseEnvAllowlist(raw: unknown): string[] | null {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "string") items = raw.split(/[\s,]+/);
  else return null;
  const entries = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (entries.length === 0 && !Array.isArray(raw)) return null;
  return [...new Set(entries)];
}

/** Entries must be an exact `NAME` or a `NAME_*` prefix. */
export function invalidAllowlistEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !ALLOWLIST_ENTRY_RE.test(entry));
}

function compile(entries: readonly string[]): CompiledAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of entries) {
    if (!ALLOWLIST_ENTRY_RE.test(entry)) continue;
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else exact.add(entry);
  }
  return { exact, prefixes };
}

/** Does the text hold anything URL-like: a scheme separator (also escaped) or a `user:password@`? */
export function looksUrlLike(text: string): boolean {
  return URL_LIKE_RES.some((re) => re.test(text));
}

/** What one whole URL carries and where it leads. */
interface UrlFacts {
  /** A database scheme (postgres, mysql, redis, ...). */
  database: boolean;
  /** Userinfo (a user, a password or both) or a credential query parameter. */
  credential: boolean;
  /** The effective destination is the VM itself: literal loopback or a unix socket, and no other endpoint parameter. */
  local: boolean;
}

function decodeUrlPart(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Read a text as exactly one URL, or return null. Every decision is made on the
 * text itself, not on what one parser makes of it: the text must be one
 * `scheme://authority[/path][?query][#fragment]` in unambiguous characters,
 * with at most one `@`, in the authority; its path, query and fragment must hold
 * nothing URL-like; and `new URL` must accept it. The destination counts as
 * the VM only for the literal hosts `localhost`, `127.0.0.1` and `[::1]` (no
 * other IP spelling, no one-label name: a resolver or a DNS search domain can
 * take those off the VM), an empty host, or a percent-encoded socket path, and
 * only when no query parameter names another endpoint (libpq's `host`,
 * `hostaddr`, `service`, ...), except a `host`/`socket` of absolute paths.
 */
function wholeUrlFacts(text: string): UrlFacts | null {
  const match = WHOLE_URL_RE.exec(text);
  if (!match) return null;
  const [, scheme, authority, rest] = match;
  if (looksUrlLike(rest)) return null;
  const at = authority.indexOf("@");
  if (at !== authority.lastIndexOf("@")) return null;
  try {
    new URL(text);
  } catch {
    return null;
  }
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  let credential = at >= 0;
  const endpoints: Array<[string, string]> = [];
  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) {
    const fragmentAt = rest.indexOf("#", queryAt);
    const query = rest.slice(queryAt + 1, fragmentAt >= 0 ? fragmentAt : undefined);
    for (const pair of query.split(/[&;]/)) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const name = decodeUrlPart(eq >= 0 ? pair.slice(0, eq) : pair);
      const value = decodeUrlPart(eq >= 0 ? pair.slice(eq + 1) : "");
      if (name == null || value == null) return null;
      if (CREDENTIAL_PARAM_RE.test(name)) credential = true;
      if (ENDPOINT_PARAM_RE.test(name)) endpoints.push([name, value]);
    }
  }
  const decodedHost = decodeUrlPart(hostport);
  const localAuthority = hostport === "" || LOOPBACK_HOSTPORT_RE.test(hostport) || (decodedHost != null && decodedHost.startsWith("/"));
  const localEndpoints = endpoints.every(
    ([name, value]) => SOCKET_PARAM_RE.test(name) && value.length > 0 && value.split(",").every((entry) => entry.startsWith("/")),
  );
  return { database: DATABASE_SCHEME_RE.test(scheme), credential, local: localAuthority && localEndpoints };
}

/** What a value holds, read fail-closed. */
interface ValueInspection {
  /** URL-like text that is not one whole URL (also inside JSON): the value must not reach the VM. */
  unsafe: boolean;
  /** The value is, as a whole, one URL (the only form a database-named variable may take). */
  whole: boolean;
  /** Every URL found: the value itself, or each JSON string that is one. */
  urls: UrlFacts[];
  /** A JWT that only shows once JSON escapes are decoded. */
  jwt: boolean;
}

/** Every string (keys included) in a parsed JSON value, iteratively (no recursion limit). */
function jsonStrings(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item)) stack.push(...item);
    else if (item && typeof item === "object") {
      for (const [key, value] of Object.entries(item)) {
        out.push(key);
        stack.push(value);
      }
    }
  }
  return out;
}

/**
 * Never take a URL that parses as proof that the value around it is safe. A
 * value with nothing URL-like in it passes. One that has something URL-like
 * passes only as one whole URL (wholeUrlFacts), or as JSON whose every
 * URL-like string (keys too, JSON escapes decoded) is one whole URL. Anything
 * else is unsafe. JSON with escapes is decoded even when the raw text looks
 * harmless, because escapes such as `\u0065yJ` (`eyJ`) or `\u0040` (`@`)
 * hide a JWT or a `user:password@` from the raw-text checks.
 */
function inspectValue(value: string): ValueInspection {
  const text = value.trim();
  const urlLike = looksUrlLike(text);
  if (urlLike) {
    const whole = wholeUrlFacts(text);
    if (whole) return { unsafe: false, whole: true, urls: [whole], jwt: false };
  }
  if (!urlLike && !text.includes("\\")) return { unsafe: false, whole: false, urls: [], jwt: false };
  let parsed: unknown;
  try {
    parsed = /^[[{"]/.test(text) ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return { unsafe: urlLike, whole: false, urls: [], jwt: false };
  const inspection: ValueInspection = { unsafe: false, whole: false, urls: [], jwt: false };
  for (const entry of jsonStrings(parsed)) {
    if (containsJwt(entry)) inspection.jwt = true;
    if (!looksUrlLike(entry)) continue;
    const facts = wholeUrlFacts(entry.trim());
    if (facts) inspection.urls.push(facts);
    else inspection.unsafe = true;
  }
  return inspection;
}

function isBase64UrlChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95;
}

/**
 * Is there a JWT in the text: a JSON header and a JSON payload (both base64url
 * of `{"`), as in "Bearer eyJ...", a JSON blob or an MCP header? The same
 * matches as /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./, in one pass: the text
 * is cut into maximal base64url runs, and a JWT is a run that holds `eyJ` with
 * at least one character after it, then `.`, then a run that starts with `eyJ`
 * and has at least one more character, then `.`.
 */
export function containsJwtInText(value: string): boolean {
  const length = value.length;
  // The run that ended at the `.` just before the current run can start a JWT.
  let previousRunOpensJwt = false;
  let index = 0;
  while (index <= length) {
    const start = index;
    // The first `eyJ` in this run (offset from the run start), or -1.
    let eyj = -1;
    while (index < length && isBase64UrlChar(value.charCodeAt(index))) {
      if (eyj < 0 && index - start >= 2 && value.charCodeAt(index) === 74 && value.charCodeAt(index - 1) === 121 && value.charCodeAt(index - 2) === 101) {
        eyj = index - 2 - start;
      }
      index += 1;
    }
    const runLength = index - start;
    const endsAtDot = index < length && value.charCodeAt(index) === 46;
    if (previousRunOpensJwt && endsAtDot && eyj === 0 && runLength >= 4) return true;
    previousRunOpensJwt = endsAtDot && eyj >= 0 && eyj + 3 < runLength;
    // Step over the one character that ended the run (a `.` or any other).
    index += 1;
  }
  return false;
}

/** Does the value carry a JWT anywhere (bare, behind "Bearer ", or inside JSON or a header)? */
export function containsJwt(value: string): boolean {
  return containsJwtInText(value) || JWT_WHOLE_VALUE_RE.test(value.trim());
}

/** A provider-credential family (PLANETSCALE_, GITHUB_, ...) that never reaches a VM. */
export function isDeniedEnvFamily(name: string): boolean {
  const upper = name.toUpperCase();
  return DENIED_NAME_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const GITHUB_BROKER_TOKEN_NAME = "PAPERCLIP_GITHUB_BROKER_TOKEN";
const GITHUB_CAPABILITY_MAX_LENGTH = 4096;
const THREE_BASE64URL_SEGMENTS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Is `value` the managed-GitHub capability Paperclip minted for run `runId`
 * (server runtime-tools-token.ts, scope `github_credentials`)? The plugin cannot
 * verify the signature; it checks what makes the token harmless in the VM: one
 * compact HS256 JWT of bounded size, scope `github_credentials`, bound to this
 * run (the run id the same env carries), not expired. The controller rechecks
 * the signature, the live run and the grants on every use.
 */
export function isRunGithubCapability(value: string, runId: string | undefined, now: number = Date.now()): boolean {
  if (!runId || value.length > GITHUB_CAPABILITY_MAX_LENGTH || !THREE_BASE64URL_SEGMENTS_RE.test(value)) return false;
  const [header, claims] = value.split(".").map(decodeJwtSegment);
  if (!header || !claims || header.alg !== "HS256") return false;
  return (
    claims.scope === "github_credentials" &&
    claims.run_id === runId &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > now
  );
}

// Paperclip stages a sandbox run's launchers in
// <remoteCwd>/.paperclip-runtime/paperclip-runner/github/<run id> (adapter-utils
// execution-target.ts githubOperationLauncherDirectory: path.posix.join, so no
// `.`, `..` or empty segment, and a run id of [A-Za-z0-9_-]). remoteCwd is any
// plain absolute path remoteWorkspaceDirProblem accepts, spaces and non-ASCII
// included, so the prefix is checked by its shape, not by a character class.
const GITHUB_LAUNCHER_DIR_SUFFIX_RE = /\/\.paperclip-runtime\/paperclip-runner\/github\/[A-Za-z0-9_-]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const GITHUB_LAUNCHER_SHELL_FILES: Readonly<Record<string, string>> = { ZDOTDIR: "", BASH_ENV: "/.bashrc" };

/** The launcher dir when the run's PATH starts with one, else undefined. */
function githubLauncherDirOf(path: string | undefined): string | undefined {
  const first = path?.split(":")[0];
  if (!first?.startsWith("/") || CONTROL_CHAR_RE.test(first) || !GITHUB_LAUNCHER_DIR_SUFFIX_RE.test(first)) return undefined;
  // Absolute, so the first segment is the empty one before the leading slash.
  const plain = first.split("/").slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return plain ? first : undefined;
}

/**
 * Is `value` what prepareGitHubOperationLaunchers sets `name` (ZDOTDIR or
 * BASH_ENV) to, for the launcher dir that leads the run's PATH? Those profiles
 * re-export that PATH (and unset empty git identity values), so in the VM they
 * keep the launcher `git` first.
 */
export function isGithubLauncherShellValue(name: string, value: string, launcherDir: string | undefined): boolean {
  const suffix = GITHUB_LAUNCHER_SHELL_FILES[name];
  return suffix !== undefined && launcherDir !== undefined && value === `${launcherDir}${suffix}`;
}

interface RunContext {
  runId?: string;
  githubLauncherDir?: string;
}

/** Decide one entry. Returns null when it may reach the VM. */
function decide(name: string, value: string, allow: CompiledAllowlist, run: RunContext = {}): EnvDropReason | null {
  if (!ENV_NAME_RE.test(name)) return "invalid_name";
  const exact = allow.exact.has(name);
  if (!exact && !allow.prefixes.some((prefix) => name.startsWith(prefix))) return "not_allowlisted";
  if (isDeniedEnvFamily(name)) return "denied_family";
  // Exclusive: the run's capability, named exactly, or nothing. Never falls
  // through to the rules below, which would pass a raw GitHub token.
  if (name === GITHUB_BROKER_TOKEN_NAME) {
    return exact && isRunGithubCapability(value, run.runId) ? null : "github_capability_rejected";
  }
  if (Object.hasOwn(GITHUB_LAUNCHER_SHELL_FILES, name)) {
    return isGithubLauncherShellValue(name, value, run.githubLauncherDir) ? null : "github_launcher_mismatch";
  }
  if (containsJwt(value)) return "jwt";

  const inspection = inspectValue(value);
  if (inspection.jwt) return "jwt";
  if (inspection.unsafe) return "remote_database_or_credential_url";
  if (inspection.urls.some((url) => (url.credential || url.database) && !url.local)) return "remote_database_or_credential_url";
  const databaseName = DATABASE_NAME_RE.test(name) && URL_NAME_RE.test(name);
  if (databaseName && !(inspection.whole && inspection.urls[0].local)) return "remote_database_or_credential_url";

  const tokenBudget = TOKEN_BUDGET_NAME_RE.test(name) && WHOLE_NUMBER_RE.test(value.trim());
  const secretName = SECRET_NAME_RE.test(name) && !tokenBudget;
  const sensitive = secretName || inspection.urls.some((url) => url.credential || url.database) || databaseName;
  if (sensitive && !exact) return "secret_name_needs_exact_entry";
  return null;
}

/**
 * Split the host's run env into what may reach the VM and what is dropped.
 * Only string values are considered; anything else is ignored (the old
 * behaviour). The result never carries a dropped value.
 */
export function filterRunEnv(env: Record<string, unknown> | undefined, allowlist: readonly string[]): EnvFilterResult {
  const allow = compile(allowlist);
  const kept: Array<[string, string]> = [];
  const dropped: EnvDrop[] = [];
  const run: RunContext = {
    runId: typeof env?.PAPERCLIP_RUN_ID === "string" ? env.PAPERCLIP_RUN_ID : undefined,
    githubLauncherDir: githubLauncherDirOf(typeof env?.PATH === "string" ? env.PATH : undefined),
  };
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    const reason = decide(name, value, allow, run);
    if (reason == null) kept.push([name, value]);
    else dropped.push({ name: ENV_NAME_RE.test(name) ? name : "(invalid name)", reason });
  }
  return { kept, dropped };
}

/** The allowlist a config resolves to: its own list (an empty one delivers nothing), else the default. */
export function effectiveEnvAllowlist(configured: readonly string[] | null): readonly string[] {
  return configured ?? DEFAULT_ENV_ALLOWLIST;
}

/** Would `name` (with a harmless value) reach the VM under this allowlist? */
export function allowlistDelivers(name: string, allowlist: readonly string[]): boolean {
  return decide(name, "1", compile(allowlist)) == null;
}

/** Names a Claude run through the bridge and the model-proxy tunnel cannot work without. */
export const ESSENTIAL_RUN_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_BRIDGE_TOKEN",
] as const;

// Paperclip's ACP process-session launcher (adapter-utils execution-target.ts,
// tog.22) starts the agent from a base64 envelope of its command and its whole
// launch env, project secrets included, that this filter never sees:
//   - up to 64 KiB, inline: `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=...` in the
//     launch command (legacy) or in the launch env (streamed);
//   - above 64 KiB, as a file: `<root>/process-sessions/<uuid>/command.b64`,
//     uploaded through Execute as `printf '%s' <base64 chunk> >> ...` commands,
//     then launched with only `PAPERCLIP_PROCESS_SESSION_DIR=...`.
// Every ACP step names that directory, from the first one (the wrapper script
// sync into `<root>/process-sessions`) to the launch, so refusing them all
// makes ACP fail before any envelope reaches the VM. The directory is matched
// as a path segment, absolute (`.../process-sessions`) or relative
// (`process-sessions/...` after a `cd` into the runtime root): at the start,
// or after a space, a quote, `=` or a shell operator, and followed by `/`, a
// quote, a space, a shell operator or the end.
const ACP_PROCESS_SESSION_TEXT_RE =
  /\/process-sessions(?![A-Za-z0-9_.-])|(?:^|[\s'"=;&|()<>:`])process-sessions(?:\/|['"\s;&|()<>:`]|$)|(?<![A-Za-z0-9_.-])command\.b64|PAPERCLIP_PROCESS_SESSION_(?:COMMAND_B64|DIR)=/;
const ACP_PROCESS_SESSION_ENV_NAMES = ["PAPERCLIP_PROCESS_SESSION_COMMAND_B64", "PAPERCLIP_PROCESS_SESSION_DIR"] as const;

/**
 * Is this an Execute call from Paperclip's ACP process-session launcher? True
 * when the command or an argument names the process-session directory or its
 * `command.b64` envelope file, carries the inline envelope or the session-dir
 * assignment, or when the env holds either launcher variable. Such a call is
 * refused: the agent it starts would get an environment this filter cannot see.
 */
export function isAcpProcessSessionCommand(
  command: string,
  args: readonly string[],
  env?: Record<string, unknown> | undefined,
): boolean {
  if ([command, ...args].some((part) => ACP_PROCESS_SESSION_TEXT_RE.test(part))) return true;
  return env != null && ACP_PROCESS_SESSION_ENV_NAMES.some((name) => Object.hasOwn(env, name));
}

/**
 * Route a model-proxy base URL through this plugin's reverse tunnel. An
 * agent's own adapter env can name the proxy by its host-side address (for
 * example http://cliproxy:8317, a docker DNS name) and that value overrides
 * the environment's tunnel address; inside the VM the name does not resolve.
 * Only ANTHROPIC_BASE_URL pointing exactly at the tunnel target is rewritten,
 * to 127.0.0.1:<tunnelRemotePort>; scheme and path are kept.
 */
export function routeModelProxyThroughTunnel(
  entries: ReadonlyArray<[string, string]>,
  tunnel: { cliproxyTunnel: boolean; tunnelTargetHost: string; tunnelTargetPort: number; tunnelRemotePort: number },
): Array<[string, string]> {
  if (!tunnel.cliproxyTunnel) return entries.map(([name, value]) => [name, value]);
  return entries.map(([name, value]) => {
    if (name !== "ANTHROPIC_BASE_URL") return [name, value];
    let url: URL;
    try { url = new URL(value); } catch { return [name, value]; }
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (url.hostname !== tunnel.tunnelTargetHost || port !== tunnel.tunnelTargetPort) return [name, value];
    url.hostname = "127.0.0.1";
    url.port = String(tunnel.tunnelRemotePort);
    const rewritten = url.toString();
    // URL adds a trailing "/" to a bare origin; keep the caller's form.
    return [name, value.endsWith("/") || url.pathname !== "/" ? rewritten : rewritten.replace(/\/$/, "")];
  });
}
