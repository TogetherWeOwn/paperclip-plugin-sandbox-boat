import { describe, expect, it } from "vitest";
import {
  DURATION_HISTORY_LIMIT,
  DURATION_HISTORY_TTL_MS,
  durationKey,
  isLongEnough,
  medianSeconds,
  normalizeSignature,
  readHistory,
  recordDuration,
  type DurationSample,
  type DurationStore,
} from "./duration-history.js";

const NOW = Date.parse("2026-10-26T00:00:00Z");

class MapStore implements DurationStore {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

const sample = (seconds: number, at: number = NOW): DurationSample => ({ seconds, at });

describe("medianSeconds", () => {
  it("returns null for empty or fully expired history", () => {
    expect(medianSeconds([], NOW)).toBe(null);
    expect(medianSeconds([sample(120, NOW - DURATION_HISTORY_TTL_MS - 1)], NOW)).toBe(null);
  });

  it("medians odd and even counts, ignoring expired samples", () => {
    expect(medianSeconds([sample(60), sample(120), sample(180)], NOW)).toBe(120);
    expect(medianSeconds([sample(60), sample(180)], NOW)).toBe(120);
    expect(medianSeconds([sample(10_000, NOW - DURATION_HISTORY_TTL_MS - 1), sample(120), sample(180)], NOW)).toBe(150);
  });

  it("ignores malformed samples", () => {
    expect(medianSeconds([{ seconds: NaN, at: NOW } as DurationSample, sample(100)], NOW)).toBe(100);
  });
});

describe("isLongEnough", () => {
  it("is false for unknown history", () => {
    expect(isLongEnough([], NOW, 120)).toBe(false);
  });

  it("compares the median against the threshold", () => {
    expect(isLongEnough([sample(119), sample(121)], NOW, 120)).toBe(true);
    expect(isLongEnough([sample(30), sample(40)], NOW, 120)).toBe(false);
  });
});

describe("recordDuration", () => {
  it("bounds history to the newest samples", async () => {
    const store = new MapStore();
    const key = durationKey("repo:x", "node-public-1", normalizeSignature("node", "npm", ["test"]));
    for (let i = 0; i < DURATION_HISTORY_LIMIT + 5; i++) {
      await recordDuration(store, key, sample(i));
    }
    const history = await readHistory(store, key);
    expect(history).toHaveLength(DURATION_HISTORY_LIMIT);
    expect(history[0]!.seconds).toBe(5);
  });

  it("keeps signatures distinct per tool, runner and argv", () => {
    expect(normalizeSignature("node", "npm", ["test"])).not.toBe(normalizeSignature("node", "yarn", ["test"]));
    expect(normalizeSignature("node", "npm", ["test"])).not.toBe(normalizeSignature("node", "npm", ["test", "--", "a.test.ts"]));
    expect(normalizeSignature("node", "npm", ["test"])).not.toBe(normalizeSignature("python", "pytest", ["test"]));
  });

  it("scopes keys per repo and profile", () => {
    expect(durationKey("repo:a", "node-public-1", "s")).not.toBe(durationKey("repo:b", "node-public-1", "s"));
    expect(durationKey("repo:a", "node-public-1", "s")).not.toBe(durationKey("repo:a", "python-public-1", "s"));
  });
});
