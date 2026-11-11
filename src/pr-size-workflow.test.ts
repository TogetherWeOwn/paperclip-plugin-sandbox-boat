import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard for the pr-size caller workflow: all logic lives in the org
// .github repository, and this repo keeps only a thin caller pinned to
// one immutable commit. A future change that drops the required gate,
// repins the three reusable refs to different SHAs, or points at a
// non-org reusable must fail here first, while the diff is still small.
const workflow = readFileSync(new URL("../.github/workflows/pr-size.yml", import.meta.url), "utf8");

function jobBlock(name: string): string {
  const startMarker = `\n  ${name}:`;
  const start = workflow.indexOf(startMarker);
  expect(start, `job ${name} must exist`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + startMarker.length);
  const next = rest.search(/\n  [a-z][\w-]*:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

function usesRef(block: string): string {
  // Anchor to the start of a line (after optional indentation) so a
  // commented-out `uses:` line (`# uses: ...`) cannot satisfy the guard.
  const match = block.match(/^\s*uses:\s*TogetherWeOwn\/\.github\/(\S+)@([0-9a-f]{40})/m);
  expect(match, `job must call an org reusable pinned to a full SHA: ${block}`).not.toBeNull();
  return match![1] + "@" + match![2];
}

describe("pr-size caller workflow", () => {
  it("calls all three org reusables pinned to the same full commit SHA", () => {
    const refs = ["pr-size", "pr-size-gate", "pr-size-weekly"].map((name) => usesRef(jobBlock(name)));
    expect(refs[0].startsWith(".github/workflows/pr-size.yml@")).toBe(true);
    expect(refs[1].startsWith(".github/workflows/pr-size-gate.yml@")).toBe(true);
    expect(refs[2].startsWith(".github/workflows/pr-size-weekly.yml@")).toBe(true);
    expect(refs[0].split("@")[1]).toBe(refs[1].split("@")[1]);
    expect(refs[1].split("@")[1]).toBe(refs[2].split("@")[1]);
  });

  it("keeps the advisory label job read-light and the required gate job blocking", () => {
    expect(jobBlock("pr-size")).toContain("issues: write");
    expect(jobBlock("pr-size-gate")).toContain("pull-requests: write");
    // The gate job name is the required check context stem: GitHub reports
    // it as `pr-size-gate / gate`, so the caller job must stay `pr-size-gate`.
    expect(workflow).toContain("name: pr-size-gate");
    expect(workflow).not.toContain("name: gate");
  });

  it("excludes only repo-generated paths the org script does not already cover", () => {
    // dist/, node_modules/, lockfiles, snapshots and fixture trees are
    // built-in org exclusions; this repo commits none beyond them, so
    // exclude-extra must stay empty rather than silence real lines.
    expect(jobBlock("pr-size")).toContain('exclude-extra: ""');
    expect(jobBlock("pr-size-gate")).toContain('exclude-extra: ""');
  });
});
