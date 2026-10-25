import { containsJwt } from "../env-policy.js";
import { OFFLOAD_BOUNDS, OFFLOAD_VERSION, type OffloadSubmitRequest } from "./protocol.js";

export interface ValidateOptions {
  allowRustflags?: boolean;
}

export type ValidateResult = { ok: true; value: OffloadSubmitRequest } | { ok: false; detail: string };

const KNOWN_KEYS = new Set([
  "version",
  "commandId",
  "executionWorkspaceId",
  "cwdRelative",
  "argv",
  "env",
  "queueTimeoutMs",
  "timeoutMs",
  "dryRun",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERM_COLOR = new Set(["auto", "always", "never"]);
const BACKTRACE = new Set(["0", "1", "full"]);
const MAX_RUSTFLAGS_BYTES = 2048;

function invalid(detail: string): ValidateResult {
  return { ok: false, detail };
}

/** Reject absolute paths and any `..` that escapes the workspace root. */
function cwdProblem(cwd: string): string | null {
  if (cwd.length === 0 || cwd.length > 1024) return "cwdRelative must be 1..1024 chars";
  if (cwd.startsWith("/") || /^[A-Za-z]:/.test(cwd)) return "cwdRelative must be relative";
  if (cwd.includes("\\") || /[\u0000-\u001f\u007f]/.test(cwd)) return "cwdRelative holds invalid characters";
  const stack: string[] = [];
  for (const segment of cwd.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return "cwdRelative escapes the workspace";
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return null;
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function bodyTooLarge(rawBody: string): boolean {
  return Buffer.byteLength(rawBody, "utf8") > OFFLOAD_BOUNDS.maxBodyBytes;
}

export function validateSubmit(body: unknown, options: ValidateOptions = {}): ValidateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body must be a JSON object");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) return invalid(`unknown key ${JSON.stringify(key)}`);
  }
  if (record.version !== OFFLOAD_VERSION) return invalid(`version must be ${OFFLOAD_VERSION}`);
  if (typeof record.commandId !== "string" || !UUID_RE.test(record.commandId)) return invalid("commandId must be a UUID");
  if (typeof record.executionWorkspaceId !== "string" || !UUID_RE.test(record.executionWorkspaceId)) {
    return invalid("executionWorkspaceId must be a UUID");
  }
  if (typeof record.cwdRelative !== "string") return invalid("cwdRelative must be a string");
  const cwd = cwdProblem(record.cwdRelative);
  if (cwd) return invalid(cwd);

  const argv = record.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a.length === 0)) {
    return invalid("argv must be a non-empty array of non-empty strings");
  }
  if (argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))) return invalid("argv holds invalid control characters");
  if (argv.length > OFFLOAD_BOUNDS.maxArgs) return invalid(`argv holds more than ${OFFLOAD_BOUNDS.maxArgs} args`);
  if (Buffer.byteLength(JSON.stringify(argv), "utf8") > OFFLOAD_BOUNDS.maxArgvBytes) {
    return invalid("argv exceeds 32 KiB encoded");
  }

  const env = record.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return invalid("env must be an object");
  const envRecord = env as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(envRecord), "utf8") > OFFLOAD_BOUNDS.maxEnvBytes) {
    return invalid("env exceeds 4 KiB encoded");
  }
  for (const [key, value] of Object.entries(envRecord)) {
    if (typeof value !== "string") return invalid(`env ${JSON.stringify(key)} must be a string`);
    if (value.length > MAX_RUSTFLAGS_BYTES && (key === "RUSTFLAGS" || key === "RUSTDOCFLAGS")) {
      return invalid(`env ${JSON.stringify(key)} exceeds its bound`);
    }
    if (containsJwt(value)) return invalid(`env ${JSON.stringify(key)} carries a credential`);
    if (key === "CARGO_TERM_COLOR") {
      if (!TERM_COLOR.has(value)) return invalid("CARGO_TERM_COLOR must be auto|always|never");
    } else if (key === "RUST_BACKTRACE") {
      if (!BACKTRACE.has(value)) return invalid("RUST_BACKTRACE must be 0|1|full");
    } else if (key === "RUSTFLAGS" || key === "RUSTDOCFLAGS") {
      if (!options.allowRustflags) return invalid(`env ${JSON.stringify(key)} needs profile validation`);
      if (/[\u0000-\u001f\u007f]/.test(value)) return invalid(`env ${JSON.stringify(key)} holds control characters`);
    } else {
      // Unknown keys are rejected, never silently stripped and claimed compatible.
      return invalid(`env ${JSON.stringify(key)} is not allowlisted`);
    }
  }

  if (!isIntIn(record.queueTimeoutMs, OFFLOAD_BOUNDS.queueTimeoutMs.min, OFFLOAD_BOUNDS.queueTimeoutMs.max)) {
    return invalid(`queueTimeoutMs must be ${OFFLOAD_BOUNDS.queueTimeoutMs.min}..${OFFLOAD_BOUNDS.queueTimeoutMs.max}`);
  }
  if (!isIntIn(record.timeoutMs, OFFLOAD_BOUNDS.commandTimeoutMs.min, OFFLOAD_BOUNDS.commandTimeoutMs.max)) {
    return invalid(`timeoutMs must be ${OFFLOAD_BOUNDS.commandTimeoutMs.min}..${OFFLOAD_BOUNDS.commandTimeoutMs.max}`);
  }
  if (typeof record.dryRun !== "boolean") return invalid("dryRun must be a boolean");

  return {
    ok: true,
    value: {
      version: OFFLOAD_VERSION,
      commandId: record.commandId as string,
      executionWorkspaceId: record.executionWorkspaceId as string,
      cwdRelative: record.cwdRelative as string,
      argv: argv as string[],
      env: envRecord as Record<string, string>,
      queueTimeoutMs: record.queueTimeoutMs as number,
      timeoutMs: record.timeoutMs as number,
      dryRun: record.dryRun,
    },
  };
}
