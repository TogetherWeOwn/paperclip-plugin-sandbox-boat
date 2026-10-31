// Prints one line saying how many cgroup-gated tests ran. On GitHub Actions it
// also adds a notice annotation and a per-test table to the job summary, so a
// green run shows whether the runner had delegated cgroup v2.
import { appendFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";
import "./cgroup-gate.js";

export default class CgroupGateReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const rows: Array<{ file: string; name: string; state: string }> = [];
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        if (!test.meta().cgroupGated) continue;
        rows.push({ file: testModule.relativeModuleId, name: test.fullName, state: test.result().state });
      }
    }
    if (rows.length === 0) return;
    const count = (state: string) => rows.filter((row) => row.state === state).length;
    const line = `cgroup v2 gated tests: ${count("passed")} passed, ${count("failed")} failed, `
      + `${count("skipped")} skipped (no delegated cgroup v2) of ${rows.length}`;
    process.stdout.write(`\n${line}\n`);
    if (process.env.GITHUB_ACTIONS !== "true") return;
    process.stdout.write(`::notice title=cgroup-gated tests::${line}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    appendFileSync(summary, [`### ${line}`, "", "| State | Test | File |", "| --- | --- | --- |",
      ...rows.map((row) => `| ${row.state} | ${row.name.replaceAll("|", "\\|")} | ${row.file} |`), "", ""].join("\n"));
  }
}
