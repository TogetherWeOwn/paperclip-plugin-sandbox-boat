// Checks the real @boatdev/sdk calls this plugin makes, at the HTTP level,
// against docs.boat.dev/api/v1: paths, methods, headers and bodies.
import { describe, expect, it } from "vitest";
import { createSdkBoatApi } from "./boat-client.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function capture(responseBody: Record<string, unknown> = {}) {
  const calls: Captured[] = [];
  const fetchApi = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null),
    });
    return new Response(JSON.stringify({ ok: true, type: "x", ...responseBody }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = createSdkBoatApi({ apiKey: "boat_wire_test", apiBase: "https://boat.dev/api/v1", fetchApi });
  return { api, calls };
}

const sandbox = { id: "bx_wire0001", name: "n", state: "ready", desktopAvailable: false, snapshotAvailable: true };

describe("@boatdev/sdk wire format", () => {
  it("create sends the bearer key, the Idempotency-Key header and our cost-safe body", async () => {
    const { api, calls } = capture({ status: "ready", ttlSeconds: 7200, sandbox });
    await api.create({
      idempotencyKey: "pcboat-abc",
      type: "default",
      ttlSeconds: 7200,
      monitoring: false,
      failFast: true,
      noEnv: true,
      env: { PAPERCLIP_BOAT_VM: "paperclip-0123456789abcdef" },
      from: "warm-template",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://boat.dev/api/v1/sandboxes");
    expect(calls[0].headers.authorization).toBe("Bearer boat_wire_test");
    expect(calls[0].headers["idempotency-key"]).toBe("pcboat-abc");
    expect(calls[0].body).toEqual({
      type: "default",
      ttlSeconds: 7200,
      monitoring: false,
      failFast: true,
      noEnv: true,
      env: { PAPERCLIP_BOAT_VM: "paperclip-0123456789abcdef" },
      from: "warm-template",
    });
  });

  it("resume, stop, extend (PATCH ttlSeconds) and sshkey hit the documented endpoints", async () => {
    const { api, calls } = capture({ id: "bx_wire0001", status: "ready", sandbox, hostKey: "ssh-ed25519 AAAA", machineIp: "203.0.113.1" });
    await api.resume({ sandboxId: "bx_wire0001", failFast: true, ttlSeconds: 7200 });
    await api.stop({ sandboxId: "bx_wire0001" });
    await api.update({ sandboxId: "bx_wire0001", ttlSeconds: 7200 });
    await api.update({ sandboxId: "bx_wire0001", name: "paperclip-0123456789abcdef" });
    await api.sshKey({ sandboxId: "bx_wire0001", key: "ssh-ed25519 AAAAPUB paperclip-boat" });
    expect(calls.map((call) => `${call.method} ${call.url.replace("https://boat.dev/api/v1", "")}`)).toEqual([
      "POST /sandboxes/bx_wire0001/resume",
      "POST /sandboxes/bx_wire0001/stop",
      "PATCH /sandboxes/bx_wire0001",
      "PATCH /sandboxes/bx_wire0001",
      "POST /sandboxes/bx_wire0001/sshkey",
    ]);
    expect(calls[0].body).toEqual({ failFast: true, ttlSeconds: 7200 });
    expect(calls[2].body).toEqual({ ttlSeconds: 7200 });
    expect(calls[3].body).toEqual({ name: "paperclip-0123456789abcdef" });
    expect(calls[4].body).toEqual({ key: "ssh-ed25519 AAAAPUB paperclip-boat" });
  });

  it("delete carries the X-Ascii-Confirm-Delete header with the sandbox id", async () => {
    const { api, calls } = capture({ operation: { id: "op_1", status: "accepted" } });
    await api.deleteSandbox({ sandboxId: "bx_wire0001", xAsciiConfirmDelete: "bx_wire0001" });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://boat.dev/api/v1/sandboxes/bx_wire0001");
    expect(calls[0].headers["x-ascii-confirm-delete"]).toBe("bx_wire0001");
  });

  it("usage and limits are plain reads", async () => {
    const { api, calls } = capture({
      sandboxId: "bx_wire0001",
      sandboxType: "default",
      billingMultiplier: 1,
      since: "2026-10-22T18:00:00.000Z",
      until: "2026-10-22T18:30:00.000Z",
      seconds: 1800,
      dollars: 0.018,
      secondsPerDollar: 100000,
      running: false,
    });
    await api.usage({ sandboxId: "bx_wire0001", since: "2026-10-22T18:00:00.000Z", until: "2026-10-22T18:30:00.000Z" });
    await api.limits({});
    expect(calls[0].method).toBe("GET");
    const usageUrl = new URL(calls[0].url);
    expect(usageUrl.pathname).toBe("/api/v1/sandboxes/bx_wire0001/usage");
    expect(usageUrl.searchParams.get("since")).toBe("2026-10-22T18:00:00.000Z");
    expect(usageUrl.searchParams.get("until")).toBe("2026-10-22T18:30:00.000Z");
    expect(`${calls[1].method} ${new URL(calls[1].url).pathname}`).toBe("GET /api/v1/limits");
  });

  it("named snapshots save and delete through /named-snapshots", async () => {
    const { api, calls } = capture({ status: "saving", snapshot: { name: "tpl", status: "saving", sourceSandboxId: "bx_wire0001", createdAt: "2026-10-22T18:00:00.000Z" } });
    await api.saveNamedSnapshot({ sandboxId: "bx_wire0001", name: "tpl" });
    await api.deleteNamedSnapshot({ name: "tpl" });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /api/v1/named-snapshots",
      "DELETE /api/v1/named-snapshots/tpl",
    ]);
    expect(calls[0].body).toEqual({ sandboxId: "bx_wire0001", name: "tpl" });
  });
});
