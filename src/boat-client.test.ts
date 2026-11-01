// Every Boat API request is bounded: a stalled provider stream (or a connect
// that never completes) must reject near the request timeout instead of
// hanging the caller — above all the single-flight sweep — forever.
import { describe, expect, it } from "vitest";
import { createSdkBoatApi, withBoatRequestTimeout } from "./boat-client.js";

const apiBase = "https://boat.dev/api/v1";
const json = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sandbox = { id: "bx_timeout01", name: "n", state: "ready", desktopAvailable: false, snapshotAvailable: true };

/** A fetch that never settles on its own and ignores its abort signal (a stalled connect/stream). */
function hangingFetch(calls: string[]) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return new Promise<Response>(() => {});
  };
}

describe("boat API request timeouts", () => {
  it("rejects a read whose fetch never settles, near the request timeout", async () => {
    const calls: string[] = [];
    const api = createSdkBoatApi({ apiKey: "k", apiBase, fetchApi: hangingFetch(calls), requestTimeoutMs: 40, longRequestTimeoutMs: 40 });
    const started = Date.now();
    await expect(api.get({ sandboxId: "bx_timeout01" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it("rejects a fetch that settles only when its signal aborts", async () => {
    const fetchApi = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const api = createSdkBoatApi({ apiKey: "k", apiBase, fetchApi, requestTimeoutMs: 40 });
    const started = Date.now();
    await expect(api.limits({})).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives create/resume/fork the long timeout while reads keep the short one", async () => {
    const slow = async (): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return json({ ok: true, type: "x", status: "ready", sandbox });
    };
    const api = createSdkBoatApi({ apiKey: "k", apiBase, fetchApi: slow, requestTimeoutMs: 30, longRequestTimeoutMs: 500 });
    await expect(api.get({ sandboxId: "bx_timeout01" })).rejects.toThrow();
    await expect(api.create({ type: "default" })).resolves.toBeTruthy();
    await expect(api.resume({ sandboxId: "bx_timeout01" })).resolves.toBeTruthy();
  });

  it("honours the caller's own abort signal before the timeout", async () => {
    const wrapped = withBoatRequestTimeout(hangingFetch([]), { requestTimeoutMs: 60_000 });
    const caller = new AbortController();
    const started = Date.now();
    const pending = wrapped(`${apiBase}/sandboxes/bx_timeout01`, { signal: caller.signal });
    setTimeout(() => caller.abort(new Error("caller gave up")), 20);
    await expect(pending).rejects.toThrow("caller gave up");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("passes a fast response through with a live (unaborted) signal attached", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const fetchApi = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenSignal = init?.signal;
      return json({ ok: true, sandbox });
    };
    const api = createSdkBoatApi({ apiKey: "k", apiBase, fetchApi, requestTimeoutMs: 5_000 });
    await expect(api.get({ sandboxId: "bx_timeout01" })).resolves.toBeTruthy();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
