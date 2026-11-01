import { ESSENTIAL_RUN_ENV, allowlistDelivers, invalidAllowlistEntries, isDeniedEnvFamily, parseEnvAllowlist } from "./env-policy.js";
import { BOAT_SIZES, parseSizeCostTable, parseTaskClass } from "./size-policy.js";
import type { BoatSize, SizeCostTable } from "./size-policy.js";
export { BOAT_SIZES, PRICE_PER_HOUR } from "./size-policy.js";
export type { BoatSize } from "./size-policy.js";

// Driver config for the boat sandbox provider. Defaults match the boat free
// trial (docs.boat.dev/free-trial): 2 sandboxes at once, 75 starts per day,
// 25 h of compute, auto-stop at most 2 h, sizes small and default only.

export const DEFAULT_API_BASE = "https://boat.dev/api/v1";

export interface BoatDriverConfig {
  apiKey: string | null;
  costApiKey: string | null;
  apiBase: string;
  size: BoatSize;
  taskClass: string;
  sizeCostTable: SizeCostTable;
  templateSnapshot: string | null;
  boatEnvironment: string | null;
  noEnv: boolean;
  /** Retain provider command/process telemetry for newly created VMs. */
  monitoring: boolean;
  autoStopMinutes: number;
  idleStopMinutes: number;
  staleLeaseMinutes: number;
  deleteAfterDays: number;
  maxActive: number;
  maxStartsPerDay: number;
  minComputeHoursLeft: number;
  failFast: boolean;
  noReadyMachineRetries: number;
  namePrefix: string;
  timeoutMs: number;
  stopConfirmTimeoutMs: number;
  cliproxyTunnel: boolean;
  tunnelRemotePort: number;
  tunnelTargetHost: string;
  tunnelTargetPort: number;
  sshConnectTimeoutSec: number;
  remoteWorkspaceDir: string | null;
  allowPaidNamedSnapshots: boolean;
  maxOffloadVms: number;
  offloadIdleStopSeconds: number;
  /** Host receiver budgets for one guest-produced sync-out archive. */
  syncOutMaxBytes: number;
  syncOutMaxFiles: number;
  syncOutDiskReserveBytes: number;
  /**
   * Paperclip's own envelope flag (not a boat setting). The host passes it to
   * the plugin and keeps only what the plugin returns as normalized config, so
   * it must survive normalization or per-card lease reuse silently turns off.
   */
  reuseLease: boolean;
  /**
   * Run env names that may reach the VM: exact names and `NAME_*` prefixes.
   * Null: the built-in DEFAULT_ENV_ALLOWLIST (env-policy.ts). An empty list:
   * nothing reaches the VM. Everything else the host passes is dropped.
   */
  envAllowlist: string[] | null;
}

export const CONFIG_DEFAULTS = {
  apiBase: DEFAULT_API_BASE,
  size: "small" as BoatSize,
  noEnv: true,
  monitoring: true,
  autoStopMinutes: 120,
  idleStopMinutes: 5,
  staleLeaseMinutes: 20,
  deleteAfterDays: 7,
  maxActive: 2,
  maxStartsPerDay: 70,
  minComputeHoursLeft: 1.0,
  failFast: true,
  noReadyMachineRetries: 2,
  namePrefix: "paperclip",
  timeoutMs: 300_000,
  stopConfirmTimeoutMs: 120_000,
  cliproxyTunnel: true,
  tunnelRemotePort: 8317,
  tunnelTargetHost: "127.0.0.1",
  tunnelTargetPort: 8317,
  sshConnectTimeoutSec: 15,
  allowPaidNamedSnapshots: false,
  reuseLease: false,
  maxOffloadVms: 4,
  offloadIdleStopSeconds: 15,
  // 8 GiB / 200k entries per archive covers a large workspace sync including
  // build output; the 10 GiB reserve (never below 5% of the filesystem) keeps
  // one hostile archive from filling the disk Paperclip itself runs on.
  syncOutMaxBytes: 8 * 1024 * 1024 * 1024,
  syncOutMaxFiles: 200_000,
  syncOutDiskReserveBytes: 10 * 1024 * 1024 * 1024,
};

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? CONFIG_DEFAULTS.namePrefix)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 20) : CONFIG_DEFAULTS.namePrefix;
}

function normalizeApiBase(value: string | null): string {
  if (!value) return DEFAULT_API_BASE;
  return value.replace(/\/+$/, "");
}

export function parseDriverConfig(raw: Record<string, unknown>): BoatDriverConfig {
  const sizeRaw = (str(raw.size) ?? CONFIG_DEFAULTS.size).toLowerCase();
  const size = (BOAT_SIZES as readonly string[]).includes(sizeRaw) ? (sizeRaw as BoatSize) : CONFIG_DEFAULTS.size;
  return {
    apiKey: str(raw.apiKey),
    costApiKey: str(raw.costApiKey),
    apiBase: normalizeApiBase(str(raw.apiBase)),
    size,
    taskClass: parseTaskClass(raw.taskClass),
    sizeCostTable: parseSizeCostTable(raw.sizeCostTable),
    templateSnapshot: str(raw.templateSnapshot),
    boatEnvironment: str(raw.boatEnvironment),
    noEnv: bool(raw.noEnv, CONFIG_DEFAULTS.noEnv),
    monitoring: bool(raw.monitoring, CONFIG_DEFAULTS.monitoring),
    autoStopMinutes: Math.trunc(num(raw.autoStopMinutes, CONFIG_DEFAULTS.autoStopMinutes)),
    idleStopMinutes: num(raw.idleStopMinutes, CONFIG_DEFAULTS.idleStopMinutes),
    staleLeaseMinutes: num(raw.staleLeaseMinutes, CONFIG_DEFAULTS.staleLeaseMinutes),
    deleteAfterDays: num(raw.deleteAfterDays, CONFIG_DEFAULTS.deleteAfterDays),
    maxActive: Math.trunc(num(raw.maxActive, CONFIG_DEFAULTS.maxActive)),
    maxStartsPerDay: Math.trunc(num(raw.maxStartsPerDay, CONFIG_DEFAULTS.maxStartsPerDay)),
    minComputeHoursLeft: num(raw.minComputeHoursLeft, CONFIG_DEFAULTS.minComputeHoursLeft),
    failFast: bool(raw.failFast, CONFIG_DEFAULTS.failFast),
    noReadyMachineRetries: Math.max(0, Math.trunc(num(raw.noReadyMachineRetries, CONFIG_DEFAULTS.noReadyMachineRetries))),
    namePrefix: normalizeNamePrefix(str(raw.namePrefix)),
    timeoutMs: Math.trunc(num(raw.timeoutMs, CONFIG_DEFAULTS.timeoutMs)),
    stopConfirmTimeoutMs: Math.trunc(num(raw.stopConfirmTimeoutMs, CONFIG_DEFAULTS.stopConfirmTimeoutMs)),
    cliproxyTunnel: bool(raw.cliproxyTunnel, CONFIG_DEFAULTS.cliproxyTunnel),
    tunnelRemotePort: Math.trunc(num(raw.tunnelRemotePort, CONFIG_DEFAULTS.tunnelRemotePort)),
    tunnelTargetHost: str(raw.tunnelTargetHost) ?? CONFIG_DEFAULTS.tunnelTargetHost,
    tunnelTargetPort: Math.trunc(num(raw.tunnelTargetPort, CONFIG_DEFAULTS.tunnelTargetPort)),
    sshConnectTimeoutSec: Math.trunc(num(raw.sshConnectTimeoutSec, CONFIG_DEFAULTS.sshConnectTimeoutSec)),
    remoteWorkspaceDir: str(raw.remoteWorkspaceDir),
    allowPaidNamedSnapshots: bool(raw.allowPaidNamedSnapshots, CONFIG_DEFAULTS.allowPaidNamedSnapshots),
    maxOffloadVms: Math.trunc(num(raw.maxOffloadVms, CONFIG_DEFAULTS.maxOffloadVms)),
    offloadIdleStopSeconds: num(raw.offloadIdleStopSeconds, CONFIG_DEFAULTS.offloadIdleStopSeconds),
    syncOutMaxBytes: Math.trunc(num(raw.syncOutMaxBytes, CONFIG_DEFAULTS.syncOutMaxBytes)),
    syncOutMaxFiles: Math.trunc(num(raw.syncOutMaxFiles, CONFIG_DEFAULTS.syncOutMaxFiles)),
    syncOutDiskReserveBytes: Math.trunc(num(raw.syncOutDiskReserveBytes, CONFIG_DEFAULTS.syncOutDiskReserveBytes)),
    reuseLease: bool(raw.reuseLease, CONFIG_DEFAULTS.reuseLease),
    envAllowlist: parseEnvAllowlist(raw.envAllowlist),
  };
}

/** The VM user's home on boat; boat's snapshots save it (docs.boat.dev/snapshots/whats-saved). */
export const BOAT_VM_HOME = "/home/user";

/**
 * Why a remoteWorkspaceDir cannot be used, or null. It must be a plain
 * absolute path below the VM home: only there does the home `~/.boatignore`
 * (shell.ts, runtimeDirScript) leave `.paperclip-runtime` out of boat's
 * snapshots, so any other root fails every start (each one spends a start).
 * The path is used as typed (no ~ or $HOME expansion).
 */
export function remoteWorkspaceDirProblem(value: string | null): string | null {
  if (value == null) return null;
  const segments = value.replace(/\/+$/, "").split("/");
  const belowHome = value.startsWith(`${BOAT_VM_HOME}/`) && segments.length > BOAT_VM_HOME.split("/").length;
  const plain = !segments.some((segment) => segment === "." || segment === "..");
  // A control character (a newline above all) would break the path the VM reports back.
  // Bash expands BASH_ENV (Paperclip's GitHub launcher .bashrc below this root)
  // before it opens it, so a `$`, backtick or backslash would run code in every
  // non-interactive bash; the env policy drops such launcher paths.
  if (belowHome && plain && !/[\u0000-\u001f\u007f$`\\]/.test(value)) return null;
  return `remoteWorkspaceDir must be a plain absolute path below ${BOAT_VM_HOME} (for example ${BOAT_VM_HOME}/paperclip-workspace, no . or .. segments, no ~ or $HOME, no $, backtick or backslash: shells would expand them), where ~/.boatignore keeps .paperclip-runtime out of boat's snapshots: ${JSON.stringify(value)}.`;
}

const UUID_SECRET_REF_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSecretRef(value: string): boolean {
  return UUID_SECRET_REF_RE.test(value);
}

/**
 * Whether the host-level keys (BOAT_API_KEY, BOAT_READONLY_KEY) may be sent to
 * this config's apiBase. Only the default boat API gets them: apiBase is an
 * ordinary environment field, so a foreign base must bring its own key.
 */
export function hostKeysAllowed(config: BoatDriverConfig): boolean {
  return config.apiBase === DEFAULT_API_BASE;
}

const FOREIGN_API_BASE_KEY_ERROR = `apiBase other than ${DEFAULT_API_BASE} needs its own apiKey in config: the host BOAT_API_KEY is only sent to the default boat API.`;

/** The ops key: config first, then the host-level BOAT_API_KEY fallback (same pattern as exe-dev's EXE_API_KEY). */
export function resolveApiKey(config: BoatDriverConfig): string {
  if (config.apiKey) return config.apiKey;
  if (!hostKeysAllowed(config)) throw new Error(FOREIGN_API_BASE_KEY_ERROR);
  const fromEnv = process.env.BOAT_API_KEY?.trim() ?? "";
  if (!fromEnv) throw new Error("boat environments need an API key in config (apiKey) or BOAT_API_KEY on the host.");
  return fromEnv;
}

/** Read-only key for cost reads when configured; otherwise the ops key. */
export function resolveCostApiKey(config: BoatDriverConfig): string {
  if (config.costApiKey) return config.costApiKey;
  const fromEnv = hostKeysAllowed(config) ? process.env.BOAT_READONLY_KEY?.trim() : undefined;
  return fromEnv ? fromEnv : resolveApiKey(config);
}

export function validateDriverConfig(config: BoatDriverConfig, raw: Record<string, unknown>): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawSize = str(raw.size);
  if (rawSize && !(BOAT_SIZES as readonly string[]).includes(rawSize.toLowerCase())) {
    errors.push(`size must be one of ${BOAT_SIZES.join(", ")}.`);
  }
  if (!config.apiKey && !hostKeysAllowed(config)) {
    errors.push(FOREIGN_API_BASE_KEY_ERROR);
  } else if (!config.apiKey && !process.env.BOAT_API_KEY?.trim()) {
    errors.push("boat environments need an API key in config (apiKey) or BOAT_API_KEY on the host.");
  }
  try {
    new URL(config.apiBase);
  } catch {
    errors.push("apiBase must be a valid URL.");
  }
  if (config.autoStopMinutes < 1 || config.autoStopMinutes > 43_200) {
    errors.push("autoStopMinutes must be between 1 and 43200 (30 days, boat's maximum).");
  } else if (config.autoStopMinutes > 120) {
    warnings.push("autoStopMinutes is above 120: the boat free trial refuses auto-stop above 2 hours (trial_auto_stop_required).");
  }
  if (config.idleStopMinutes < 1) errors.push("idleStopMinutes must be at least 1.");
  if (config.staleLeaseMinutes < config.idleStopMinutes) {
    errors.push("staleLeaseMinutes must be at least idleStopMinutes.");
  }
  if (config.deleteAfterDays < 1 || config.deleteAfterDays > 13) {
    errors.push("deleteAfterDays must be between 1 and 13 (boat deletes a stopped disk after 14 days).");
  }
  const workspaceProblem = remoteWorkspaceDirProblem(config.remoteWorkspaceDir);
  if (workspaceProblem) errors.push(workspaceProblem);
  if (config.maxActive < 1) errors.push("maxActive must be at least 1.");
  if (config.maxStartsPerDay < 1) errors.push("maxStartsPerDay must be at least 1.");
  if (config.maxOffloadVms < 1) errors.push("maxOffloadVms must be at least 1.");
  if (config.offloadIdleStopSeconds < 1 || config.offloadIdleStopSeconds > 3600) {
    errors.push("offloadIdleStopSeconds must be between 1 and 3600.");
  }
  if (config.syncOutMaxBytes < 1024 * 1024 || config.syncOutMaxBytes > 32 * 1024 * 1024 * 1024) {
    errors.push("syncOutMaxBytes must be between 1048576 (1 MiB) and 34359738368 (32 GiB).");
  }
  if (config.syncOutMaxFiles < 1 || config.syncOutMaxFiles > 1_000_000) {
    errors.push("syncOutMaxFiles must be between 1 and 1000000.");
  }
  if (config.syncOutDiskReserveBytes < 0 || config.syncOutDiskReserveBytes > 1024 * 1024 * 1024 * 1024) {
    errors.push("syncOutDiskReserveBytes must be between 0 and 1099511627776 (1 TiB).");
  } else if (config.syncOutDiskReserveBytes === 0) {
    warnings.push("syncOutDiskReserveBytes is 0: the host tar receiver still keeps 5% of the target filesystem free, but no fixed reserve beyond it.");
  }
  if (config.minComputeHoursLeft < 0) errors.push("minComputeHoursLeft cannot be negative.");
  if (config.timeoutMs < 10_000 || config.timeoutMs > 86_400_000) {
    errors.push("timeoutMs must be between 10000 and 86400000.");
  }
  if (config.stopConfirmTimeoutMs < 5_000 || config.stopConfirmTimeoutMs > 1_800_000) {
    errors.push("stopConfirmTimeoutMs must be between 5000 and 1800000.");
  }
  for (const [name, port] of [
    ["tunnelRemotePort", config.tunnelRemotePort],
    ["tunnelTargetPort", config.tunnelTargetPort],
  ] as const) {
    if (port < 1 || port > 65_535) errors.push(`${name} must be between 1 and 65535.`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(config.tunnelTargetHost) && !/^[0-9a-fA-F:]+$/.test(config.tunnelTargetHost)) {
    errors.push("tunnelTargetHost must be a hostname or an IP address.");
  }
  if (config.size === "large" || config.size === "xlarge") {
    warnings.push(`size ${config.size} needs a paid boat plan (the trial allows small and default only).`);
  }
  if (!config.noEnv) {
    warnings.push(
      "noEnv is off: if the boat environment is not marked safe for third parties, sandboxes receive the account's GitHub token, secrets and model logins.",
    );
  }
  if (config.envAllowlist && config.envAllowlist.length === 0) {
    warnings.push(
      `envAllowlist is empty: no run env reaches the VM (deny-all), so a Claude run gets none of ${ESSENTIAL_RUN_ENV.join(", ")} and cannot reach the model proxy or Paperclip's sandbox bridge. Remove envAllowlist to use the built-in list.`,
    );
  } else if (config.envAllowlist) {
    const invalid = invalidAllowlistEntries(config.envAllowlist);
    if (invalid.length > 0) {
      errors.push(`envAllowlist entries must be an exact NAME or a NAME_* prefix: ${invalid.slice(0, 5).join(", ")}.`);
    } else {
      const missing = ESSENTIAL_RUN_ENV.filter((name) => !allowlistDelivers(name, config.envAllowlist!));
      if (missing.length > 0) {
        warnings.push(
          `envAllowlist does not deliver ${missing.join(", ")}: a Claude run needs them for the model proxy and Paperclip's sandbox bridge. Secret-looking names need an exact entry; a NAME_* prefix never delivers them.`,
        );
      }
      const never = config.envAllowlist.filter((entry) => isDeniedEnvFamily(entry));
      if (never.length > 0) {
        warnings.push(`envAllowlist names keys this plugin never sends to a VM (provider credentials): ${never.slice(0, 5).join(", ")}.`);
      }
    }
  }
  if (config.cliproxyTunnel && config.tunnelTargetHost === "127.0.0.1") {
    warnings.push(
      "tunnelTargetHost is 127.0.0.1: the reverse tunnel reaches port tunnelTargetPort on the machine that runs the plugin worker. Inside a container, point it at the CLIProxy service name instead (for example cliproxy).",
    );
  }
  return { errors, warnings };
}
