import { describe, expect, it } from "vitest";
import { cgroupGateFailure } from "./test-support/cgroup-gate-reporter.js";
import { CGROUP_GATED } from "./test-support/cgroup-gate.js";

declare module "vitest" {
  interface TaskMeta {
    cgroupGateProbe?: boolean;
  }
}

describe("cgroup gate reporter", () => {
  it("only reports gated skips when delegation is not required", () => {
    expect(cgroupGateFailure({ passed: 0, failed: 0, skipped: 7, total: 7 }, false)).toBe(null);
    expect(cgroupGateFailure({ passed: 0, failed: 0, skipped: 0, total: 0 }, false)).toBe(null);
  });
  it("fails a required run when any gated test skips", () => {
    expect(cgroupGateFailure({ passed: 6, failed: 0, skipped: 1, total: 7 }, true)).toMatch(/1 cgroup-gated test\(s\) skipped/);
    expect(cgroupGateFailure({ passed: 0, failed: 0, skipped: 7, total: 7 }, true)).toMatch(/no cgroup-gated test passed/);
  });
  it("fails a required run in which no gated test ran at all", () => {
    expect(cgroupGateFailure({ passed: 0, failed: 0, skipped: 0, total: 0 }, true)).toMatch(/no cgroup-gated test passed/);
  });
  it("passes a required run in which every gated test ran", () => {
    expect(cgroupGateFailure({ passed: 7, failed: 0, skipped: 0, total: 7 }, true)).toBe(null);
  });
});

// A real cgroupGated skip here would trip PAPERCLIP_TEST_CGROUP_REQUIRED=1, so
// a probe key stands in for it to show declared meta survives a skip.
describe("declaration-time gate tag", () => {
  it.skip("probe skipped before its callback runs", { meta: { cgroupGateProbe: true } }, () => {});
  it("tags gated tests through test options, which reach the reporter even for it.skip", (ctx) => {
    expect(CGROUP_GATED).toEqual({ meta: { cgroupGated: true } });
    const probe = ctx.task.suite!.tasks.find((task) => task.name === "probe skipped before its callback runs");
    expect(probe?.mode).toBe("skip");
    expect(probe?.meta.cgroupGateProbe).toBe(true);
  });
});
