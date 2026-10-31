import { defineConfig } from "vitest/config";

// These suites drive the real guest supervisor and watchdog over loopback SSH.
// The guest script has fixed wall-clock deadlines (5s to prepare, 2s for its
// lock) sized for an idle VM, which the full parallel suite can starve. They
// run after every other file finishes.
const guestWatchdogSuites = ["src/offload-ssh.test.ts", "src/offload-ssh-runtime.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    // Setting reporters replaces the defaults, so keep the GitHub failure
    // annotations vitest would otherwise add on Actions.
    reporters: [
      "default",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
      "./src/test-support/cgroup-gate-reporter.ts",
    ],
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.ts"], exclude: guestWatchdogSuites, sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "guest-watchdog", include: guestWatchdogSuites, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
