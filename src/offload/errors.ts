import {
  OFFLOAD_ERROR_HTTP,
  OFFLOAD_EXIT,
  type OffloadErrorCode,
  type OffloadErrorEnvelope,
  type OffloadTerminalResult,
} from "./protocol.js";

const TITLES: Record<OffloadErrorCode, string> = {
  OFFLOAD_UNAVAILABLE: "Offload unavailable",
  OFFLOAD_INVALID_REQUEST: "Invalid offload request",
  OFFLOAD_UNAUTHORIZED: "Offload authentication required",
  OFFLOAD_FORBIDDEN: "Offload forbidden",
  OFFLOAD_IDEMPOTENCY_CONFLICT: "Command ID already used with a different payload",
  OFFLOAD_SYNC_STAGED: "Remote run returned workspace changes for review",
  OFFLOAD_SYNC_CONFLICT: "Remote run diverged from local edits",
  OFFLOAD_EXECUTION_UNKNOWN: "Remote execution state unknown",
  OFFLOAD_RESULT_EXPIRED: "Command result expired",
  OFFLOAD_OUTPUT_LIMIT: "Command output limit exhausted",
};

const NEXT_ACTIONS: Record<OffloadErrorCode, string> = {
  OFFLOAD_UNAVAILABLE: "fall back locally only with a durable never-started receipt, else exit 75",
  OFFLOAD_INVALID_REQUEST: "correct the request",
  OFFLOAD_UNAUTHORIZED: "fix the run authentication binding",
  OFFLOAD_FORBIDDEN: "fix the workspace authorization binding",
  OFFLOAD_IDEMPOTENCY_CONFLICT: "correct client bookkeeping; never remint the ID",
  OFFLOAD_SYNC_STAGED: "inspect/apply the staged artifact with local tools",
  OFFLOAD_SYNC_CONFLICT: "reconcile local edits with the staged artifact",
  OFFLOAD_EXECUTION_UNKNOWN: "reconcile the same command ID; never replay locally",
  OFFLOAD_RESULT_EXPIRED: "inspect evidence; never resubmit as known not started",
  OFFLOAD_OUTPUT_LIMIT: "inspect the retained output",
};

export interface ErrorOptions {
  commandId?: string | null;
  remoteStarted?: boolean | null;
  fallbackSafe?: boolean;
}

export function offloadError(code: OffloadErrorCode, detail: string, options: ErrorOptions = {}): OffloadErrorEnvelope {
  return {
    type: "https://boat.offload/errors/v1",
    title: TITLES[code],
    status: OFFLOAD_ERROR_HTTP[code],
    code,
    detail,
    retryable: code === "OFFLOAD_UNAVAILABLE" || code === "OFFLOAD_EXECUTION_UNKNOWN",
    next_action: NEXT_ACTIONS[code],
    commandId: options.commandId ?? null,
    remoteStarted: options.remoteStarted ?? null,
    fallbackSafe: options.fallbackSafe ?? false,
  };
}

export type ShimErrorDecision = { action: "fallback" } | { action: "exit"; code: number };

/**
 * What the shim does with an error envelope. Local fallback happens only on
 * a durable never-started receipt; every other failure is an explicit exit.
 */
export function exitForError(envelope: OffloadErrorEnvelope): ShimErrorDecision {
  switch (envelope.code) {
    case "OFFLOAD_UNAVAILABLE":
      if (envelope.remoteStarted === false && envelope.fallbackSafe === true) return { action: "fallback" };
      return { action: "exit", code: OFFLOAD_EXIT.executionUnknown };
    case "OFFLOAD_INVALID_REQUEST":
    case "OFFLOAD_IDEMPOTENCY_CONFLICT":
      return { action: "exit", code: OFFLOAD_EXIT.invalidRequest };
    case "OFFLOAD_UNAUTHORIZED":
    case "OFFLOAD_FORBIDDEN":
      return { action: "exit", code: OFFLOAD_EXIT.auth };
    case "OFFLOAD_SYNC_STAGED":
    case "OFFLOAD_SYNC_CONFLICT":
    case "OFFLOAD_OUTPUT_LIMIT":
      return { action: "exit", code: OFFLOAD_EXIT.syncStaged };
    case "OFFLOAD_EXECUTION_UNKNOWN":
    case "OFFLOAD_RESULT_EXPIRED":
      return { action: "exit", code: OFFLOAD_EXIT.executionUnknown };
  }
}

/**
 * Shim exit for a terminal remote result. A nonzero cargo exit or a remote
 * signal is preserved even when a staged artifact is present; only a clean
 * cargo success with staged/conflicting outputs maps to 74.
 */
export function exitForTerminal(result: OffloadTerminalResult): number {
  if (result.signal !== null && result.signal !== undefined) return 128 + result.signal;
  if (result.exitCode !== 0) return result.exitCode;
  if (result.syncBack.state === "staged" || result.syncBack.state === "conflict") return OFFLOAD_EXIT.syncStaged;
  return 0;
}
