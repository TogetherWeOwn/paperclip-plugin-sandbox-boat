// Suite guard: no test may leave a guest-side run-cancellation record in
// host /tmp. Several fixtures execute the "remote" supervisor/cancel
// scripts on this host (loopback SSH, the local relay, direct spawns);
// a cancel that wins the admission race writes a {"cancelled": true}
// tombstone that is kept by design, so without a pinned record directory
// every such run leaked one /tmp/paperclip-boat-run-<id> file forever.
// Snapshot /tmp before the suite and fail the run if new records remain
// after it. Leftover files are named in the error, not deleted: they are
// the evidence for the leak.
import { readdirSync } from "node:fs";

const RECORD_PATTERN = /^paperclip-boat-run-[0-9a-f]{32}$/;

// Null on a read failure: the guard must fail closed, never pass unseen.
function snapshot(): Set<string> | null {
  try {
    return new Set(readdirSync("/tmp").filter((name) => RECORD_PATTERN.test(name)));
  } catch {
    return null;
  }
}

function fail(message: string): void {
  process.stderr.write(`\n${message}\n`);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=run-record guard::${message}\n`);
  // A teardown throw only logs "error during close"; vitest never lowers
  // the exit code, so this survives to the shell (same as the cgroup gate).
  process.exitCode = 1;
}

export default function setup(): () => void {
  const before = snapshot();
  if (before === null) throw new Error("run-record guard: cannot read /tmp to snapshot run records");
  return () => {
    const after = snapshot();
    if (after === null) {
      fail("run-record guard: cannot read /tmp after the suite; leaks cannot be ruled out");
      return;
    }
    const leaked = [...after].filter((name) => !before.has(name));
    if (leaked.length > 0) {
      fail(`tests leaked ${leaked.length} run-record file(s) into host /tmp: ${leaked.join(", ")}`);
    }
  };
}
