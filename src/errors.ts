// Reading boat API errors. The SDK rejects a non-2xx answer with a
// ResponseError that carries the raw Response; boat puts the details in a JSON
// envelope (docs.boat.dev/api/v1#error-model). boat sends no Retry-After
// header: the wait is in the body (retryAfterSeconds, retryAfter, window).

export interface BoatErrorInfo {
  status: number | null;
  code: string | null;
  message: string;
  window: string | null;
  limit: number | null;
  retryAfterSeconds: number | null;
  retryable: boolean | null;
  requestId: string | null;
}

const parsedBodies = new WeakMap<object, Promise<Record<string, unknown> | null>>();

function isResponseError(error: unknown): error is { name: string; response: Response; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ResponseError" &&
    typeof (error as { response?: unknown }).response === "object"
  );
}

async function readBody(error: { response: Response }): Promise<Record<string, unknown> | null> {
  let pending = parsedBodies.get(error);
  if (!pending) {
    pending = (async () => {
      try {
        const text = await error.response.clone().text();
        const parsed = text ? JSON.parse(text) : null;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    parsedBodies.set(error, pending);
  }
  return pending;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function describeBoatError(error: unknown): Promise<BoatErrorInfo> {
  if (!isResponseError(error)) {
    const status = asNumber((error as { status?: unknown } | null)?.status);
    const code = asString((error as { code?: unknown } | null)?.code);
    return {
      status,
      code,
      message: error instanceof Error ? error.message : String(error),
      window: null,
      limit: null,
      retryAfterSeconds: null,
      retryable: null,
      requestId: null,
    };
  }
  const body = (await readBody(error)) ?? {};
  const nested = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
  const details = (nested.details && typeof nested.details === "object" ? nested.details : {}) as Record<string, unknown>;
  return {
    status: error.response.status,
    code: asString(body.code) ?? asString(nested.code) ?? asString(body.error),
    message: asString(body.message) ?? asString(nested.message) ?? error.message,
    window: asString(body.window) ?? asString(details.window),
    limit: asNumber(body.limit) ?? asNumber(details.limit),
    retryAfterSeconds:
      asNumber(body.retryAfterSeconds) ?? asNumber(body.retryAfter) ?? asNumber(details.retryAfterSeconds),
    retryable: typeof details.retryable === "boolean" ? details.retryable : null,
    requestId: asString(body.requestId),
  };
}

export async function isNotFound(error: unknown): Promise<boolean> {
  const info = await describeBoatError(error);
  return info.status === 404;
}

/** A clear, agent-readable failure. `code` is stable so callers and logs can match on it. */
export class BoatProviderError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BoatProviderError";
    this.code = code;
    this.details = details;
  }
}

export function formatBoatError(info: BoatErrorInfo): string {
  const parts = [info.status != null ? `HTTP ${info.status}` : null, info.code, info.message].filter(Boolean);
  return parts.join(" ");
}
