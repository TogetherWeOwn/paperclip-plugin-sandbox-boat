// Tags tests that need delegated cgroup v2 so cgroup-gate-reporter.ts can say
// which of them actually ran. Without delegation they must skip, never pass.
import type { TestContext } from "vitest";

export const CGROUP_SKIP_NOTE = "needs delegated cgroup v2";

declare module "vitest" {
  interface TaskMeta {
    cgroupGated?: boolean;
  }
}

export function markCgroupGated(ctx: TestContext): void {
  ctx.task.meta.cgroupGated = true;
}
