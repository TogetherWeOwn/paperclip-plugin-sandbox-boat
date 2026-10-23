import { describe, expect, it } from "vitest";
import { costPerJob, recomputeSizeCostTable, selectSize } from "./size-policy.js";

const now = Date.parse("2026-10-23T08:00:00Z");
const sample = { taskClass: "rust", size: "default", status: "completed", durationSeconds: 316, hourlyRate: 0.036, measuredAt: "2026-10-23T07:14:00Z" };

describe("weekly cost table", () => {
  it("keeps only completed samples from the last seven days, never failed attempts", () => {
    const table = recomputeSizeCostTable([
      sample,
      { ...sample, size: "large", durationSeconds: 182, hourlyRate: 0.072 },
      { ...sample, size: "small", status: "failed", durationSeconds: 65, hourlyRate: 0.018 },
      { ...sample, size: "small", measuredAt: "2026-10-15T08:00:00Z", durationSeconds: 1 },
    ], now);
    expect(table.rust.small).toBeUndefined();
    expect(table.rust.default).toEqual({ durationSeconds: 316, hourlyRate: 0.036, measuredAt: sample.measuredAt, sampleCount: 1 });
    expect(selectSize({ taskClass: "rust", size: "default", sizeCostTable: table })).toMatchObject({ size: "default", expectedCostDollars: 0.00316 });
  });

  it("averages actual job costs, including a rate change, not the product of separate means", () => {
    const table = recomputeSizeCostTable([
      { ...sample, durationSeconds: 360, hourlyRate: 0.036 },
      { ...sample, durationSeconds: 180, hourlyRate: 0.072, measuredAt: "2026-10-23T07:15:00Z" },
    ], now);
    expect(table.rust.default).toMatchObject({ durationSeconds: 270, sampleCount: 2, measuredAt: "2026-10-23T07:15:00Z" });
    expect(costPerJob(table.rust.default!)).toBeCloseTo(0.0036, 12);
  });

  it("separates classes and returns an empty table when all samples are old or failed", () => {
    const table = recomputeSizeCostTable([sample, { ...sample, taskClass: "coverage" }], now);
    expect(Object.keys(table).sort()).toEqual(["coverage", "rust"]);
    expect(recomputeSizeCostTable([{ ...sample, status: "failed" }], now)).toEqual({});
  });

  it.each([
    { ...sample, durationSeconds: 0 },
    { ...sample, hourlyRate: NaN },
    { ...sample, size: "tiny" },
    { ...sample, taskClass: "" },
    { ...sample, measuredAt: "yesterday" },
    { ...sample, measuredAt: "2026-10-24T08:00:00Z" },
    { ...sample, status: "unknown" },
  ])("rejects invalid completed log entries instead of making them cheap candidates", (bad) => {
    expect(() => recomputeSizeCostTable([bad], now)).toThrow(/sizeCostTable/);
  });
});
