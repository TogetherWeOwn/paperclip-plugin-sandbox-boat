// Prints one line saying how many cgroup-gated tests ran. On GitHub Actions it
// also adds a notice annotation and a per-test table to the job summary, so a
// green run shows whether the runner had delegated cgroup v2. With
// PAPERCLIP_TEST_CGROUP_REQUIRED=1 a gated skip, or no gated test passing at
// all, fails the run instead of reporting green.
import { appendFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";
import "./cgroup-gate.js";

export type CgroupGateCounts = { passed: number; failed: number; skipped: number; total: number };

export function cgroupGateFailure(counts: CgroupGateCounts, required: boolean): string | null {
  if (!required) return null;
  if (counts.passed === 0) return "PAPERCLIP_TEST_CGROUP_REQUIRED=1 but no cgroup-gated test passed";
  if (counts.skipped > 0) return `PAPERCLIP_TEST_CGROUP_REQUIRED=1 but ${counts.skipped} cgroup-gated test(s) skipped`;
  return null;
}

export default class CgroupGateReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const rows: Array<{ file: string; name: string; state: string }> = [];
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        if (!test.meta().cgroupGated) continue;
        rows.push({ file: testModule.relativeModuleId, name: test.fullName, state: test.result().state });
      }
    }
    const count = (state: string) => rows.filter((row) => row.state === state).length;
    const counts = { passed: count("passed"), failed: count("failed"), skipped: count("skipped"), total: rows.length };
    const failure = cgroupGateFailure(counts, process.env.PAPERCLIP_TEST_CGROUP_REQUIRED === "1");
    if (failure) {
      process.stderr.write(`\n${failure}\n`);
      if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=cgroup-gated tests::${failure}\n`);
      // vitest only ever raises the exit code, so this survives to the shell.
      process.exitCode = 1;
    }
    if (rows.length === 0) return;
    const line = `cgroup v2 gated tests: ${counts.passed} passed, ${counts.failed} failed, `
      + `${counts.skipped} skipped (no delegated cgroup v2) of ${counts.total}`;
    process.stdout.write(`\n${line}\n`);
    if (process.env.GITHUB_ACTIONS !== "true") return;
    process.stdout.write(`::notice title=cgroup-gated tests::${line}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    appendFileSync(summary, [`### ${line}`, "", "| State | Test | File |", "| --- | --- | --- |",
      ...rows.map((row) => `| ${row.state} | ${row.name.replaceAll("|", "\\|")} | ${row.file} |`), "", ""].join("\n"));
  }
}
