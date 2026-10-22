// All boat calls go through the official TypeScript SDK (@boatdev/sdk,
// docs.boat.dev/sdks/typescript). No hand-written REST client: every endpoint
// this plugin needs exists in the SDK, so there is no raw-REST fallback.
import { BoatApi, Configuration, waitUntilReady } from "@boatdev/sdk";
import type { FetchAPI } from "@boatdev/sdk";

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

export function createSdkBoatApi(input: BoatApiFactoryInput & { fetchApi?: FetchAPI }): BoatApi {
  return new BoatApi(
    new Configuration({
      basePath: input.apiBase,
      accessToken: input.apiKey,
      ...(input.fetchApi ? { fetchApi: input.fetchApi } : {}),
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
