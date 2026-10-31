import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBoatApiFactoryForTests, type BoatApiFactoryInput, type BoatApiLike } from "./boat-client.js";
import { DEFAULT_API_BASE, parseDriverConfig, resolveApiKey, resolveCostApiKey, validateDriverConfig } from "./config.js";
import { COMPANY, EPOCH, fixture } from "./test-support/account-admission.fixture.js";

const FOREIGN_BASE = "https://boat.example.test/api/v1";

let f: ReturnType<typeof fixture>;
let factoryCalls: BoatApiFactoryInput[];
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubEnv("BOAT_API_KEY", "host-ops-key");
  vi.stubEnv("BOAT_READONLY_KEY", "host-readonly-key");
  f = fixture();
  factoryCalls = [];
  setBoatApiFactoryForTests((input) => { factoryCalls.push(input); return f.boat as unknown as BoatApiLike; });
});
afterEach(async () => { await f.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function probe(config: Record<string, unknown>) {
  return f.manager().probe({ driverKey: "boat", companyId: COMPANY, environmentId: `env-${factoryCalls.length}-${Math.random()}`, config } as never);
}

describe("host BOAT keys and apiBase", () => {
  it("refuses a foreign apiBase without its own apiKey before any SDK client is built", async () => {
    const config = { apiBase: FOREIGN_BASE, cliproxyTunnel: false };
    const parsed = parseDriverConfig(config);
    expect(validateDriverConfig(parsed, config).errors.join("\n")).toMatch(/apiBase other than .* needs its own apiKey/);
    expect(() => resolveApiKey(parsed)).toThrow(/needs its own apiKey/);
    expect(() => resolveCostApiKey(parsed)).toThrow(/needs its own apiKey/);
    const result = await probe(config);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "boat_limits", severity: "error" })]));
    expect(factoryCalls).toEqual([]);
  });

  it("uses a foreign apiBase's own keys and never the host ones", async () => {
    const config = { apiBase: FOREIGN_BASE, apiKey: "env-ops-key", cliproxyTunnel: false };
    const parsed = parseDriverConfig(config);
    expect(validateDriverConfig(parsed, config).errors).toEqual([]);
    expect(resolveApiKey(parsed)).toBe("env-ops-key");
    // BOAT_READONLY_KEY stays home too: cost reads fall back to the config's own key.
    expect(resolveCostApiKey(parsed)).toBe("env-ops-key");
    expect(resolveCostApiKey(parseDriverConfig({ ...config, costApiKey: "env-cost-key" }))).toBe("env-cost-key");
    await probe(config);
    expect(factoryCalls.length).toBeGreaterThan(0);
    for (const call of factoryCalls) expect(call).toEqual({ apiBase: FOREIGN_BASE, apiKey: "env-ops-key" });
  });

  it("still pairs the default apiBase with the host keys", async () => {
    const config = { cliproxyTunnel: false };
    const parsed = parseDriverConfig(config);
    expect(parsed.apiBase).toBe(DEFAULT_API_BASE);
    expect(validateDriverConfig(parsed, config).errors).toEqual([]);
    expect(resolveApiKey(parsed)).toBe("host-ops-key");
    expect(resolveCostApiKey(parsed)).toBe("host-readonly-key");
    // A trailing slash normalizes to the default base.
    expect(resolveApiKey(parseDriverConfig({ apiBase: `${DEFAULT_API_BASE}/` }))).toBe("host-ops-key");
    await probe(config);
    expect(factoryCalls.length).toBeGreaterThan(0);
    for (const call of factoryCalls) expect(call.apiBase).toBe(DEFAULT_API_BASE);
  });
});
