import { describe, expect, it } from "vitest";
import {
  DURATION_HISTORY_LIMIT,
  DURATION_HISTORY_TTL_MS,
  DURATION_INDEX_KEY,
  DURATION_INDEX_LIMIT,
  durationKey,
  isLongEnough,
  MAX_DURATION_SECONDS,
  medianSeconds,
  normalizeSignature,
  pruneDurations,
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
  async delete(key: string): Promise<void> {
    this.data.delete(key);
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

  it("keeps signatures distinct per run directory, with the root keeping its original encoding", () => {
    expect(normalizeSignature("node", "npm", ["test"], ".")).toBe(JSON.stringify(["node", "npm", ["test"]]));
    expect(normalizeSignature("node", "npm", ["test"], "./")).toBe(normalizeSignature("node", "npm", ["test"]));
    expect(normalizeSignature("node", "npm", ["test"], "packages/tiny/")).toBe(normalizeSignature("node", "npm", ["test"], "packages/./tiny"));
    expect(normalizeSignature("node", "npm", ["test"], "packages/tiny")).not.toBe(normalizeSignature("node", "npm", ["test"]));
  });

  it("scopes keys per repo and profile", () => {
    expect(durationKey("repo:a", "node-public-1", "s")).not.toBe(durationKey("repo:b", "node-public-1", "s"));
    expect(durationKey("repo:a", "node-public-1", "s")).not.toBe(durationKey("repo:a", "python-public-1", "s"));
  });

  it("caps stored keys when a thousand unique signatures report", async () => {
    const store = new MapStore();
    for (let i = 0; i < 1000; i += 1) {
      await recordDuration(store,
        durationKey("repo:a", "node-public-1", normalizeSignature("node", "npm", ["run", "test", "--", `suite/${i}`])),
        sample(120 + (i % 10), NOW + i));
    }
    const keys = [...store.data.keys()].filter((key) => key !== DURATION_INDEX_KEY);
    expect(keys.length).toBeLessThanOrEqual(DURATION_INDEX_LIMIT);
    expect(keys.length).toBeGreaterThan(0);
    // Evicted keys are deleted, not just unindexed.
    for (const key of keys) expect(await store.get(key)).not.toBe(null);
    expect(store.data.size).toBe(keys.length + 1);
  });

  it("keeps all five samples under five concurrent writes to one key", async () => {
    // A store that resolves reads after a tick: without a per-key mutex the
    // five read-modify-write cycles interleave and samples are lost.
    class RacyStore extends MapStore {
      override async get(key: string): Promise<unknown> {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return super.get(key);
      }
    }
    const store = new RacyStore();
    const key = durationKey("repo:a", "node-public-1", normalizeSignature("node", "npm", ["test"]));
    await Promise.all([0, 1, 2, 3, 4].map((i) => recordDuration(store, key, sample(100 + i, NOW + i))));
    expect(await readHistory(store, key)).toHaveLength(5);
  });

  it("clamps untrusted durations to the one-day bound", async () => {
    const store = new MapStore();
    const key = durationKey("repo:a", "node-public-1", normalizeSignature("node", "npm", ["test"]));
    await recordDuration(store, key, sample(1e300, NOW));
    await recordDuration(store, key, { seconds: Number.NaN, at: NOW } as DurationSample);
    await recordDuration(store, key, { seconds: -5, at: NOW } as DurationSample);
    const history = await readHistory(store, key);
    expect(history).toHaveLength(1);
    expect(history[0]!.seconds).toBe(MAX_DURATION_SECONDS);
  });

  it("prunes expired keys in the sweep and repairs over-cap indexes", async () => {
    const store = new MapStore();
    const fresh = durationKey("repo:a", "node-public-1", normalizeSignature("node", "npm", ["test"]));
    const stale = durationKey("repo:a", "node-public-1", normalizeSignature("node", "npm", ["run", "test", "--", "old"]));
    await recordDuration(store, fresh, sample(10, NOW));
    await recordDuration(store, stale, sample(10, NOW - DURATION_HISTORY_TTL_MS - 1));
    expect(await store.get(stale)).not.toBe(null);
    await pruneDurations(store, NOW);
    expect(await store.get(stale)).toBe(null);
    expect(await readHistory(store, fresh)).toHaveLength(1);
  });
});
