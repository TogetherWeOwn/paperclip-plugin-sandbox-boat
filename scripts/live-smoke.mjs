#!/usr/bin/env node
// Live smoke test against the real boat API, through the plugin's own code
// (dist/vm-manager.js + the official @boatdev/sdk). Costs 2 starts and a few
// minutes of a `small` VM (about $0.001). Leaves nothing behind: the VM is
// deleted at the end, also on failure.
//
// Usage (key from stdin or BOAT_API_KEY; never put it in argv):
//   read -rs BOAT_API_KEY; export BOAT_API_KEY; node scripts/live-smoke.mjs
// Options (env): SMOKE_TUNNEL_HOST (default 127.0.0.1), SMOKE_TUNNEL_PORT (8317), SMOKE_SIZE (small)
import { BoatVmManager } from "../dist/vm-manager.js";

if (!process.env.BOAT_API_KEY) {
  console.error("BOAT_API_KEY is not set");
  process.exit(2);
}

const state = new Map();
const key = (input) => `${input.scopeKind}|${input.scopeId ?? ""}|${input.namespace ?? ""}|${input.stateKey}`;
const log = (level) => (message, meta) => console.log(`[${new Date().toISOString()}] ${level} ${message}${meta ? " " + JSON.stringify(meta) : ""}`);
const manager = new BoatVmManager({
  state: {
    get: async (input) => (state.has(key(input)) ? structuredClone(state.get(key(input))) : null),
    set: async (input, value) => void state.set(key(input), structuredClone(value)),
  },
  logger: { info: log("info"), warn: log("warn"), error: log("error") },
  issues: null,
});

const stamp = Date.now().toString(36);
const config = {
  size: process.env.SMOKE_SIZE ?? "small",
  namePrefix: "pcsmoke",
  tunnelTargetHost: process.env.SMOKE_TUNNEL_HOST ?? "127.0.0.1",
  tunnelTargetPort: Number(process.env.SMOKE_TUNNEL_PORT ?? 8317),
  autoStopMinutes: 30,
};
const base = { driverKey: "boat", companyId: "smoke-company", environmentId: "smoke-env", config };
const workspace = `smoke-ws-${stamp}`;
const t0 = Date.now();
const step = (name) => console.log(`\n=== ${name} (+${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let sandboxId = null;
let failed = false;

async function exec(lease, script, env = {}) {
  const result = await manager.execute({ ...base, lease, command: "sh", args: ["-c", script], env, timeoutMs: 120_000 });
  console.log(`exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.trim())} stderr=${JSON.stringify(result.stderr.trim().slice(0, 300))}`);
  return result;
}

try {
  step("probe (no VM start)");
  const probe = await manager.probe(base);
  console.log(JSON.stringify({ ok: probe.ok, diagnostics: probe.diagnostics }, null, 1));

  step("acquire run 1 (create)");
  const lease1 = await manager.acquire({ ...base, runId: `smoke-run-1-${stamp}`, executionWorkspaceId: workspace, issueId: null });
  sandboxId = lease1.providerLeaseId;
  console.log(JSON.stringify(lease1.metadata));

  step("execute: identity, env file, argv check, tunnel, marker file");
  const sentinel = `sentinel-${stamp}`;
  await exec(
    lease1,
    'echo "user=$(id -un) uid=$(id -u)"; echo "env_ok=${SMOKE_SENTINEL:+yes}"; ' +
      // The sentinel value must not appear in any process argv (grep reads it from a file).
      'printenv SMOKE_SENTINEL > /tmp/.smoke-s; echo "in_argv=$(ps -eo args | grep -c -F -f /tmp/.smoke-s)"; rm -f /tmp/.smoke-s; ' +
      'echo "tunnel_http=$(curl -s -o /dev/null -m 5 -w %{http_code} http://127.0.0.1:8317/ || echo fail)"; ' +
      'echo warm > "$HOME/paperclip-workspace/.smoke-marker"; ls -a "$HOME/paperclip-workspace" | grep -c paperclip-boat-env || true',
    { SMOKE_SENTINEL: sentinel },
  );

  step("release run 1 (stop)");
  console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease1.metadata }, "release")));

  step("acquire run 2 (resume the same card VM)");
  const lease2 = await manager.acquire({ ...base, runId: `smoke-run-2-${stamp}`, executionWorkspaceId: workspace, issueId: null });
  console.log(JSON.stringify(lease2.metadata));
  if (lease2.providerLeaseId !== sandboxId) throw new Error("expected the same VM on resume");
  await exec(lease2, 'cat "$HOME/paperclip-workspace/.smoke-marker"');

  step("release run 2 (stop)");
  console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease2.metadata }, "release")));

  step("usage summary");
  const summary = await manager.usageSummary("smoke-company", { refresh: true });
  console.log(JSON.stringify({ totals: summary.totals, runs: summary.vms[0]?.runs }, null, 1));
} catch (error) {
  failed = true;
  console.error("SMOKE FAILED:", error instanceof Error ? `${error.name} ${error.code ?? ""} ${error.message}` : String(error));
} finally {
  if (sandboxId) {
    step("destroy (delete the VM)");
    try {
      console.log(JSON.stringify(await manager.destroy({ ...base, providerLeaseId: sandboxId })));
    } catch (error) {
      failed = true;
      console.error("DELETE FAILED, delete by hand with: boat delete", sandboxId, "--yes", error?.message);
    }
  }
  await manager.shutdown();
  console.log(`\n${failed ? "SMOKE FAILED" : "SMOKE OK"} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failed ? 1 : 0);
}
