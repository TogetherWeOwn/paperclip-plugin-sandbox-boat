// Source-contract checks only: prose is not runtime permission enforcement
// or evidence of the model actually served by a provider.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const role = (name: string) => readFileSync(new URL(`../.claude/agents/${name}.md`, import.meta.url), "utf8");

it("keeps cross-review independent, concurrent and pinned without test execution", () => {
  const text = role("cross-reviewer");
  expect(text).toContain("alongside the primary assessment on the same pinned head");
  expect(text).toContain("do not share or consume preliminary conclusions until independent findings are recorded");
  expect(text).toContain("Reconcile findings afterwards, before decisions");
  expect(text).toContain("a changed head requires applicable revalidation");
  expect(text).toContain("Never edit files, run tests or builds");
  expect(text).toContain("the evidence establishing it");
  expect(text).not.toMatch(/after the main-thread review|running existing tests/i);
});

it("permits substantial qualified builder work while retaining CI and decision gates", () => {
  const text = role("builder");
  expect(text).toContain("substantial independently scoped implementation, testing, documentation or refactoring");
  expect(text).toContain("within your actual qualification and authority");
  expect(text).toContain("qualified authorized worker");
  expect(text).toContain("Full suites and CI gates run only on GitHub Actions for the exact head");
  expect(text).toContain("Never commit, push, open PRs or change Paperclip issues");
  expect(text).toContain("the accountable integrator");
  expect(text).not.toContain("the main thread keeps those");
});

it("preserves configured routes, tool surfaces and experiment exclusions", () => {
  for (const [name, model, tools] of [
    ["cross-reviewer", "gpt-6.1-sol", "Read, Grep, Glob, Bash"],
    ["builder", "claude/claude-sonnet-5-5", "Read, Grep, Glob, Bash, Edit, Write"],
  ]) {
    const text = role(name!);
    expect(text).toContain(`\nmodel: ${model}\ntools: ${tools}\n---`);
    expect(text).toContain("Agent model overrides");
    expect(text).toContain("NO-GO");
    expect(text).toContain("canary qualification");
    expect(text).not.toMatch(/gpt-\S*terra/i);
  }
  expect(role("cross-reviewer")).toContain("not a security boundary");
});
