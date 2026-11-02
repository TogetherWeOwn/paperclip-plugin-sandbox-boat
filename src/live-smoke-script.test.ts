// scripts/live-smoke.mjs must stay aligned with the manager contract it
// exercises: a card VM exists only when acquire carries an agent principal
// (resolveVmKey), and the state client the manager drives on release has a
// delete (StateClientLike). The live smoke failed twice against the real API
// on stale copies of both, so the alignment is pinned here.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveVmKey } from "./vm-manager.js";

const smoke = readFileSync(new URL("../scripts/live-smoke.mjs", import.meta.url), "utf8");

it("acquires every smoke lease as a workspace-scoped agent principal", () => {
  const acquires = smoke.split("\n").filter((line) => line.includes("manager.acquire("));
  expect(acquires).toHaveLength(3);
  for (const params of acquires) {
    expect(params).toContain("agentId:");
    expect(params).toContain("executionWorkspaceId:");
  }
});

it("resolves the smoke's acquire shape to one reusable card VM key, not a per-run key", () => {
  // Without a principal the key is the run id: release deletes the VM and no
  // later acquire can resume it — the failure this test pins against.
  expect(resolveVmKey({ executionWorkspaceId: "ws", issueId: null, runId: "r1" }).kind).toBe("run");
  const run1 = resolveVmKey({ executionWorkspaceId: "ws", issueId: null, runId: "r1", agentId: "smoke-agent" });
  const run2 = resolveVmKey({ executionWorkspaceId: "ws", issueId: null, runId: "r2", agentId: "smoke-agent" });
  expect(run1.kind).toBe("executionWorkspace");
  expect(run2.key).toBe(run1.key);
});

it("gives the smoke's state client the delete the manager calls on release", () => {
  expect(smoke).toMatch(/state:\s*\{[^}]*get:/);
  expect(smoke).toMatch(/state:\s*\{[^}]*set:/);
  expect(smoke).toMatch(/state:\s*\{[^}]*delete:/);
});
