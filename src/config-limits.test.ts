// The config limits are the operator's spend guard: maxActive, maxStartsPerDay
// and maxOffloadVms cap VMs, the timeouts bound billed waits. Each rejection
// here is what stops a bad saved config before boat spends a start.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDriverConfig, resolveApiKey, resolveCostApiKey, validateDriverConfig } from "./config.js";

const base = { apiKey: "boat_test_key_not_real" };

function errorsFor(raw: Record<string, unknown>): string[] {
  const merged = { ...base, ...raw };
  return validateDriverConfig(parseDriverConfig(merged), merged).errors;
}

let savedEnv: { api: string | undefined; readonly: string | undefined };

beforeEach(() => {
  savedEnv = { api: process.env.BOAT_API_KEY, readonly: process.env.BOAT_READONLY_KEY };
  delete process.env.BOAT_API_KEY;
  delete process.env.BOAT_READONLY_KEY;
});

afterEach(() => {
  for (const [name, value] of [["BOAT_API_KEY", savedEnv.api], ["BOAT_READONLY_KEY", savedEnv.readonly]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("validateDriverConfig limits", () => {
  it("accepts the defaults", () => {
    expect(errorsFor({})).toEqual([]);
  });

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["maxActive below 1", { maxActive: 0 }, /^maxActive must be at least 1\.$/],
    ["maxStartsPerDay below 1", { maxStartsPerDay: 0 }, /^maxStartsPerDay must be at least 1\.$/],
    ["maxOffloadVms below 1", { maxOffloadVms: 0 }, /^maxOffloadVms must be at least 1\.$/],
    ["a negative minComputeHoursLeft", { minComputeHoursLeft: -1 }, /^minComputeHoursLeft cannot be negative\.$/],
    ["idleStopMinutes below 1", { idleStopMinutes: 0, staleLeaseMinutes: 5 }, /^idleStopMinutes must be at least 1\.$/],
    ["staleLeaseMinutes below idleStopMinutes", { idleStopMinutes: 30, staleLeaseMinutes: 29 }, /^staleLeaseMinutes must be at least idleStopMinutes\.$/],
    ["offloadIdleStopSeconds of 0", { offloadIdleStopSeconds: 0 }, /^offloadIdleStopSeconds must be between 1 and 3600\.$/],
    ["offloadIdleStopSeconds above an hour", { offloadIdleStopSeconds: 3601 }, /^offloadIdleStopSeconds must be between 1 and 3600\.$/],
    ["timeoutMs below 10s", { timeoutMs: 9_999 }, /^timeoutMs must be between/],
    ["timeoutMs above a day", { timeoutMs: 86_400_001 }, /^timeoutMs must be between/],
    ["stopConfirmTimeoutMs below 5s", { stopConfirmTimeoutMs: 4_999 }, /^stopConfirmTimeoutMs must be between/],
    ["stopConfirmTimeoutMs above 30 min", { stopConfirmTimeoutMs: 1_800_001 }, /^stopConfirmTimeoutMs must be between/],
    ["tunnelRemotePort of 0", { tunnelRemotePort: 0 }, /^tunnelRemotePort must be between 1 and 65535\.$/],
    ["tunnelTargetPort above 65535", { tunnelTargetPort: 65_536 }, /^tunnelTargetPort must be between 1 and 65535\.$/],
    ["a tunnelTargetHost with shell characters", { tunnelTargetHost: "cliproxy;id" }, /^tunnelTargetHost must be a hostname or an IP address\.$/],
    ["an apiBase that is not a URL", { apiBase: "not a url" }, /^apiBase must be a valid URL\.$/],
    ["deleteAfterDays past boat's 14-day disk deletion", { deleteAfterDays: 14 }, /^deleteAfterDays must be between 1 and 13/],
    ["syncOutMaxBytes below 1 MiB", { syncOutMaxBytes: 1024 * 1024 - 1 }, /^syncOutMaxBytes must be between/],
    ["syncOutMaxBytes above the 32 GiB hard bound", { syncOutMaxBytes: 32 * 1024 * 1024 * 1024 + 1 }, /^syncOutMaxBytes must be between/],
    ["syncOutMaxFiles below 1", { syncOutMaxFiles: 0 }, /^syncOutMaxFiles must be between 1 and 1000000\.$/],
    ["syncOutMaxFiles above the hard bound", { syncOutMaxFiles: 1_000_001 }, /^syncOutMaxFiles must be between 1 and 1000000\.$/],
    ["a negative syncOutDiskReserveBytes", { syncOutDiskReserveBytes: -1 }, /^syncOutDiskReserveBytes must be between/],
  ];
  for (const [name, raw, message] of cases) {
    it(`refuses ${name}`, () => {
      const errors = errorsFor(raw);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(message);
    });
  }

  it("accepts each bound at its edge", () => {
    expect(errorsFor({
      maxActive: 1,
      maxStartsPerDay: 1,
      maxOffloadVms: 1,
      minComputeHoursLeft: 0,
      idleStopMinutes: 1,
      staleLeaseMinutes: 1,
      offloadIdleStopSeconds: 3600,
      timeoutMs: 10_000,
      stopConfirmTimeoutMs: 1_800_000,
      tunnelRemotePort: 65_535,
      tunnelTargetPort: 1,
      tunnelTargetHost: "fd00::1",
      deleteAfterDays: 13,
      syncOutMaxBytes: 32 * 1024 * 1024 * 1024,
      syncOutMaxFiles: 1_000_000,
      syncOutDiskReserveBytes: 0,
    })).toEqual([]);
  });

  it("reads string config values the same as numbers and booleans", () => {
    const config = parseDriverConfig({ ...base, maxActive: "0", noEnv: "false", monitoring: "true", size: 7 });
    expect(config.maxActive).toBe(0);
    expect(config.noEnv).toBe(false);
    expect(config.monitoring).toBe(true);
    expect(validateDriverConfig(config, { ...base, maxActive: "0" }).errors).toContain("maxActive must be at least 1.");
    // A non-numeric limit keeps its default instead of becoming NaN, which every `< 1` check would let through.
    expect(parseDriverConfig({ ...base, maxActive: "lots" }).maxActive).toBe(parseDriverConfig(base).maxActive);
  });

  it("warns about paid sizes and noEnv off without refusing them", () => {
    const raw = { ...base, size: "large", noEnv: false };
    const { errors, warnings } = validateDriverConfig(parseDriverConfig(raw), raw);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("size large needs a paid boat plan"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("noEnv is off"))).toBe(true);
  });
});

describe("API key resolution", () => {
  it("refuses a config with no key and no BOAT_API_KEY, at validation and at use", () => {
    const config = parseDriverConfig({});
    expect(validateDriverConfig(config, {}).errors).toContain("boat environments need an API key in config (apiKey) or BOAT_API_KEY on the host.");
    expect(() => resolveApiKey(config)).toThrow(/need an API key/);
    process.env.BOAT_API_KEY = "   ";
    expect(() => resolveApiKey(config)).toThrow(/need an API key/);
  });

  it("falls back to a trimmed BOAT_API_KEY, and the config key wins over it", () => {
    process.env.BOAT_API_KEY = "  boat_from_env  ";
    expect(resolveApiKey(parseDriverConfig({}))).toBe("boat_from_env");
    expect(resolveApiKey(parseDriverConfig({ apiKey: "boat_from_config" }))).toBe("boat_from_config");
  });

  it("reads costs with the read-only key when one is set, else the ops key", () => {
    process.env.BOAT_API_KEY = "boat_ops";
    expect(resolveCostApiKey(parseDriverConfig({}))).toBe("boat_ops");
    process.env.BOAT_READONLY_KEY = "boat_ro_env";
    expect(resolveCostApiKey(parseDriverConfig({}))).toBe("boat_ro_env");
    expect(resolveCostApiKey(parseDriverConfig({ costApiKey: "boat_ro_config" }))).toBe("boat_ro_config");
  });
});
