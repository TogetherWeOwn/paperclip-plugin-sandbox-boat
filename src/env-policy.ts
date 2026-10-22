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
//      - a JWT (a host-verifiable bearer credential, such as Paperclip's run
//        token);
//      - a database URL or a URL with a password, unless every such URL in the
//        value points at the VM itself (loopback, or a one-label host name such
//        as a container on the VM). A `..._DATABASE_URL` or `..._DB_URL` name
//        (also _URI, _DSN) counts as a database URL whatever its value, so it
//        needs a VM-local URL in it.
//   3. Delivered only when the allowlist names it exactly, never through a
//      prefix: a name with TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE,
//      PRIVATE_KEY, API_KEY, APIKEY, ACCESS_KEY, CREDENTIAL or COOKIE in it, and
//      a VM-local database URL or URL with a password. A `..._TOKENS` name with
//      a whole-number value is a token budget (CLAUDE_CODE_MAX_OUTPUT_TOKENS),
//      not a credential.

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
  // the JWT rule drops. PAPERCLIP_PROCESS_SESSION_COMMAND_B64 is not here: it
  // packs a whole child env that this filter cannot see into.
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_BRIDGE_MODE",
  "PAPERCLIP_BRIDGE_TOKEN",
  "PAPERCLIP_BRIDGE_*",
  "PAPERCLIP_SANDBOX_EXEC_CHANNEL",
  "PAPERCLIP_PROCESS_SESSION_DIR",
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

const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|CREDENTIAL|COOKIE/i;
const TOKEN_BUDGET_NAME_RE = /TOKENS$/i;
const WHOLE_NUMBER_RE = /^\d+$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const DATABASE_SCHEME_RE =
  /^(?:postgres(?:ql)?|mysql2?|mariadb|mongodb(?:\+srv)?|rediss?|libsql|sqlserver|mssql|cockroachdb|clickhouse|amqps?|prisma(?:\+postgres)?)(?:\+[a-z0-9]+)?:$/i;
const DATABASE_NAME_RE = /(?:^|_)(?:DATABASE|DB)(?:_|$)/i;
const URL_NAME_RE = /(?:_URL|_URI|_DSN|^DSN)$/i;
const URL_IN_TEXT_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWLIST_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:_\*)?$/;

export type EnvDropReason =
  | "not_allowlisted"
  | "denied_family"
  | "jwt"
  | "remote_database_or_credential_url"
  | "secret_name_needs_exact_entry"
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

/** Read `envAllowlist` from config: a list, or one string split on commas, spaces or newlines. Null when unset. */
export function parseEnvAllowlist(raw: unknown): string[] | null {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "string") items = raw.split(/[\s,]+/);
  else return null;
  const entries = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return entries.length > 0 ? [...new Set(entries)] : null;
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

function isVmLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  // A one-label name (a container or /etc/hosts entry on the VM). An IP address
  // or a dotted name can reach off the VM.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host) && !/^\d+$/.test(host);
}

interface UrlScan {
  /** Database URLs and URLs with a password found in the value. */
  sensitive: number;
  /** How many of those point off the VM, or could not be parsed. */
  remote: number;
  /** Every URL found, sensitive or not. */
  total: number;
  /** URLs among `total` that point off the VM, or could not be parsed. */
  totalRemote: number;
}

function scanUrls(value: string): UrlScan {
  const scan: UrlScan = { sensitive: 0, remote: 0, total: 0, totalRemote: 0 };
  for (const match of value.matchAll(URL_IN_TEXT_RE)) {
    scan.total += 1;
    let url: URL | null = null;
    try {
      url = new URL(match[0]);
    } catch {
      url = null;
    }
    const local = url != null && isVmLocalHost(url.hostname);
    if (!local) scan.totalRemote += 1;
    const database = DATABASE_SCHEME_RE.test(match[0].slice(0, match[0].indexOf(":") + 1));
    const password = url != null ? url.password.length > 0 : /:\/\/[^/@\s]*:[^/@\s]+@/.test(match[0]);
    if (database || password) {
      scan.sensitive += 1;
      if (!local) scan.remote += 1;
    }
  }
  return scan;
}

/** A provider-credential family (PLANETSCALE_, GITHUB_, ...) that never reaches a VM. */
export function isDeniedEnvFamily(name: string): boolean {
  const upper = name.toUpperCase();
  return DENIED_NAME_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Decide one entry. Returns null when it may reach the VM. */
function decide(name: string, value: string, allow: CompiledAllowlist): EnvDropReason | null {
  if (!ENV_NAME_RE.test(name)) return "invalid_name";
  const exact = allow.exact.has(name);
  if (!exact && !allow.prefixes.some((prefix) => name.startsWith(prefix))) return "not_allowlisted";
  if (isDeniedEnvFamily(name)) return "denied_family";
  if (JWT_RE.test(value.trim())) return "jwt";

  const urls = scanUrls(value);
  if (urls.remote > 0) return "remote_database_or_credential_url";
  const databaseName = DATABASE_NAME_RE.test(name) && URL_NAME_RE.test(name);
  if (databaseName && (urls.total === 0 || urls.totalRemote > 0)) return "remote_database_or_credential_url";

  const tokenBudget = TOKEN_BUDGET_NAME_RE.test(name) && WHOLE_NUMBER_RE.test(value.trim());
  const secretName = SECRET_NAME_RE.test(name) && !tokenBudget;
  const sensitive = secretName || urls.sensitive > 0 || databaseName;
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
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    const reason = decide(name, value, allow);
    if (reason == null) kept.push([name, value]);
    else dropped.push({ name: ENV_NAME_RE.test(name) ? name : "(invalid name)", reason });
  }
  return { kept, dropped };
}

/** The allowlist a config resolves to: its own list, else the default. */
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

/**
 * Paperclip's ACP process-session launcher can put a base64 envelope of the
 * child's whole env (`PAPERCLIP_PROCESS_SESSION_COMMAND_B64=...`) into the
 * command itself, where this filter cannot see it. Such a command is refused.
 */
export function carriesInlineEnvEnvelope(command: string, args: readonly string[]): boolean {
  return [command, ...args].some((part) => part.includes("PAPERCLIP_PROCESS_SESSION_COMMAND_B64="));
}
