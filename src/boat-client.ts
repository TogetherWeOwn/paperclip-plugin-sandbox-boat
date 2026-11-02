// All boat calls go through the official TypeScript SDK (@boatdev/sdk,
// docs.boat.dev/sdks/typescript). No hand-written REST client: every endpoint
// this plugin needs exists in the SDK, so there is no raw-REST fallback.
import { BoatApi, Configuration, waitUntilReady } from "@boatdev/sdk";
import type { FetchAPI } from "@boatdev/sdk";
// The SDK's own default fetch (one shared HTTP/2 connection per origin). It is
// not re-exported from the package index, so wrap it via its dist path: passing
// any other fetchApi would silently drop the shared connection for plain
// HTTP/1.1 fetch. The dependency is pinned exactly; if a future SDK moves this
// file, the build fails loudly instead of changing transport behaviour.
import { defaultFetch } from "@boatdev/sdk/dist/http2-fetch.js";

export type BoatApiLike = Pick<
  BoatApi,
  | "create"
  | "get"
  | "update"
  | "stop"
  | "resume"
  | "fork"
  | "deleteSandbox"
  | "sandboxes"
  | "sshKey"
  | "usage"
  | "limits"
  | "saveNamedSnapshot"
  | "getNamedSnapshot"
  | "deleteNamedSnapshot"
  | "listNamedSnapshots"
>;

export interface BoatApiFactoryInput {
  apiKey: string;
  apiBase: string;
}

type BoatApiFactory = (input: BoatApiFactoryInput) => BoatApiLike;

/** Default bound for one Boat API request: reads, stop, update, delete, limits. */
export const BOAT_REQUEST_TIMEOUT_MS = 30_000;
/** Bound for requests that make the provider do slow work: create, resume, fork, snapshot saves. */
export const BOAT_LONG_REQUEST_TIMEOUT_MS = 180_000;

const LONG_POST_SUFFIXES = ["/sandboxes", "/resume", "/fork", "/named-snapshots", "/snapshots"];

function requestTimeoutMs(input: RequestInfo | URL, init: RequestInit | undefined, timeouts: { request: number; long: number }): number {
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return timeouts.request;
  let pathname: string;
  try {
    pathname = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
  } catch {
    return timeouts.request;
  }
  return LONG_POST_SUFFIXES.some((suffix) => pathname.endsWith(suffix)) ? timeouts.long : timeouts.request;
}

/**
 * Bound every Boat API request. The caller's signal (if any) is composed with
 * a per-request timeout, and the underlying fetch is raced against that
 * signal: the SDK's shared-connection connect (`session()`) does not observe
 * the signal before a stream exists, so without the race a stalled connect
 * would hang the caller past the timeout. Whichever way the race settles, the
 * composed signal still aborts the in-flight stream (and a stalled response
 * body) at the deadline.
 */
export function withBoatRequestTimeout(
  fetchFn: FetchAPI,
  options: { requestTimeoutMs?: number; longRequestTimeoutMs?: number } = {},
): FetchAPI {
  const timeouts = {
    request: options.requestTimeoutMs ?? BOAT_REQUEST_TIMEOUT_MS,
    long: options.longRequestTimeoutMs ?? BOAT_LONG_REQUEST_TIMEOUT_MS,
  };
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs(input, init, timeouts));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([fetchFn(input, { ...init, signal }), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

export function createSdkBoatApi(
  input: BoatApiFactoryInput & { fetchApi?: FetchAPI; requestTimeoutMs?: number; longRequestTimeoutMs?: number },
): BoatApi {
  return new BoatApi(
    new Configuration({
      basePath: input.apiBase,
      accessToken: input.apiKey,
      fetchApi: withBoatRequestTimeout(input.fetchApi ?? defaultFetch, input),
    }),
  );
}

let factory: BoatApiFactory = (input) => createSdkBoatApi(input);
const cache = new Map<string, BoatApiLike>();

export function boatApi(input: BoatApiFactoryInput): BoatApiLike {
  // Keyed by base + key so a rotated key gets a fresh client. The key itself
  // stays in memory only, as the SDK needs it for the bearer header.
  const cacheKey = `${input.apiBase}\u0000${input.apiKey}`;
  let api = cache.get(cacheKey);
  if (!api) {
    api = factory(input);
    cache.set(cacheKey, api);
  }
  return api;
}

/** Test hook: swap the SDK for a mocked boat API. */
export function setBoatApiFactoryForTests(next: BoatApiFactory | null): void {
  factory = next ?? ((input) => createSdkBoatApi(input));
  cache.clear();
}

/** SDK helper: polls GET /sandboxes/{id} until ready, idle or running. */
export async function waitReady(
  api: BoatApiLike,
  sandboxId: string,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<unknown> {
  return waitUntilReady(api as BoatApi, sandboxId, { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs ?? 2000 });
}
