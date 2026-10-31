// Tags tests that need delegated cgroup v2 so cgroup-gate-reporter.ts can say
// which of them actually ran. Without delegation they must skip, never pass.
import type { TestContext } from "vitest";

export const CGROUP_SKIP_NOTE = "needs delegated cgroup v2";

declare module "vitest" {
  interface TaskMeta {
    cgroupGated?: boolean;
  }
}

// Pass as the test options of every gated test. Tagging at declaration keeps a
// gated test visible to the reporter even when it is skipped before its
// callback runs (it.skip or a name filter).
export const CGROUP_GATED = { meta: { cgroupGated: true } } as const;

export function markCgroupGated(ctx: TestContext): void {
  ctx.task.meta.cgroupGated = true;
}
