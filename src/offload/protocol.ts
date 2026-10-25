// Offload API v1 wire contract. Design: docs/adr/0001-heavy-command-offload.md.
// Pure types, bounds and code tables shared by the broker, the shim and tests.

export const OFFLOAD_VERSION = 1;

/** Submit bounds from the ADR: argv, env, body, timeouts. */
export const OFFLOAD_BOUNDS = {
  maxArgs: 256,
  maxArgvBytes: 32 * 1024,
  maxEnvBytes: 4 * 1024,
  maxBodyBytes: 64 * 1024,
  queueTimeoutMs: { min: 0, max: 30_000 },
  commandTimeoutMs: { min: 1_000, max: 30 * 60_000 },
  readLimitBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxCommandsPerRun: 512,
  heartbeatIntervalMs: 5_000,
  heartbeatExpiryMs: 30_000,
  recoveryBudgetMs: 10_000,
  resultRetentionMs: 24 * 60 * 60_000,
  tombstoneRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

/** Shim process exit codes (sysexits-style, per ADR). */
export const OFFLOAD_EXIT = {
  invalidRequest: 64,
  syncStaged: 74,
  executionUnknown: 75,
  auth: 77,
} as const;

export type OffloadErrorCode =
  | "OFFLOAD_UNAVAILABLE"
  | "OFFLOAD_INVALID_REQUEST"
  | "OFFLOAD_UNAUTHORIZED"
  | "OFFLOAD_FORBIDDEN"
  | "OFFLOAD_IDEMPOTENCY_CONFLICT"
  | "OFFLOAD_SYNC_STAGED"
  | "OFFLOAD_SYNC_CONFLICT"
  | "OFFLOAD_EXECUTION_UNKNOWN"
  | "OFFLOAD_RESULT_EXPIRED"
  | "OFFLOAD_OUTPUT_LIMIT";

export const OFFLOAD_ERROR_HTTP: Record<OffloadErrorCode, number> = {
  OFFLOAD_UNAVAILABLE: 503,
  OFFLOAD_INVALID_REQUEST: 400,
  OFFLOAD_UNAUTHORIZED: 401,
  OFFLOAD_FORBIDDEN: 403,
  OFFLOAD_IDEMPOTENCY_CONFLICT: 409,
  OFFLOAD_SYNC_STAGED: 409,
  OFFLOAD_SYNC_CONFLICT: 409,
  OFFLOAD_EXECUTION_UNKNOWN: 503,
  OFFLOAD_RESULT_EXPIRED: 410,
  OFFLOAD_OUTPUT_LIMIT: 413,
};

export interface OffloadErrorEnvelope {
  type: "https://boat.offload/errors/v1";
  title: string;
  status: number;
  code: OffloadErrorCode;
  detail: string;
  retryable: boolean;
  next_action: string;
  commandId: string | null;
  remoteStarted: boolean | null;
  fallbackSafe: boolean;
}

export interface OffloadSubmitRequest {
  version: typeof OFFLOAD_VERSION;
  commandId: string;
  executionWorkspaceId: string;
  cwdRelative: string;
  argv: string[];
  env: Record<string, string>;
  queueTimeoutMs: number;
  timeoutMs: number;
  dryRun: boolean;
}

export type OffloadCommandState =
  | "accepted"
  | "queued"
  | "syncing_in"
  | "starting"
  | "running"
  | "syncing_out"
  | "completed"
  | "not_started"
  | "cancelled"
  | "failed"
  | "unknown";

export interface OffloadSubmitAccepted {
  version: typeof OFFLOAD_VERSION;
  commandId: string;
  state: "queued";
  remoteStarted: false;
  fallbackSafe: false;
  eventsCursor: 0;
}

export interface OffloadOutputEvent {
  seq: number;
  stream: "stdout" | "stderr";
  dataBase64: string;
}

export interface OffloadSyncBack {
  state: "clean" | "staged" | "conflict";
  changedPaths: string[];
  conflictPaths: string[];
  artifactId: string | null;
}

export interface OffloadTerminalResult {
  exitCode: number;
  signal: number | null;
  timedOut: boolean;
  cancelled: boolean;
  syncBack: OffloadSyncBack;
  usageRecordId: string | null;
}

export interface OffloadReadResponse {
  version: typeof OFFLOAD_VERSION;
  commandId: string;
  state: OffloadCommandState;
  remoteStarted: boolean;
  fallbackSafe: boolean;
  events: OffloadOutputEvent[];
  nextCursor: number;
  result: OffloadTerminalResult | null;
  /**
   * Terminal transport failure carried alongside retained output. Staged and
   * conflicting sync results surface through `result.syncBack` instead, so the
   * shim can still preserve a nonzero cargo exit or signal with the artifact.
   */
  terminalError: OffloadErrorCode | null;
}

export interface OffloadDryRunResponse {
  version: typeof OFFLOAD_VERSION;
  commandId: string;
  mode: "remote_candidate" | "local";
  reason: string;
  profileId: string;
}
