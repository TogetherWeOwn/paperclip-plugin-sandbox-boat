#!/usr/bin/env node
// Live smoke test against the real boat API, through the plugin's own code
// (dist/vm-manager.js + the official @boatdev/sdk). Costs 2 starts and a few
// minutes of a `small` VM (about $0.001). Leaves nothing behind: the VM is
// deleted at the end, also on failure.
//
// It checks, among others: an allowlisted key arrives and denied keys do not;
// the env file is gone before the command runs; boat's ASCII_TOKEN/BOAT_* are
// in neither the command's env, ~/.bashrc, /etc/environment, nor the startup
// environ of its parent or any readable ancestor; the workspace's
// .paperclip-runtime is a symlink into /tmp, so a stand-in for Paperclip's run
// MCP config written through it never reaches /home and is gone after a stop
// and resume; and a payload killed by SIGTERM exits 143, not ssh's 255.
//
// Usage (key from stdin or BOAT_API_KEY; never put it in argv):
//   read -rs BOAT_API_KEY; export BOAT_API_KEY; node scripts/live-smoke.mjs
// Options (env): SMOKE_TUNNEL_HOST (default 127.0.0.1), SMOKE_TUNNEL_PORT (8317), SMOKE_SIZE (small)
import { DEFAULT_ENV_ALLOWLIST } from "../dist/env-policy.js";
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
  // The built-in run env allowlist plus the smoke sentinel.
  envAllowlist: [...DEFAULT_ENV_ALLOWLIST, "SMOKE_SENTINEL"],
};
const base = { driverKey: "boat", companyId: "smoke-company", environmentId: "smoke-env", config };
// Names of boat's in-VM credentials, matched at the start of an environ line (names only, never values).
const BOAT_TOKEN_NAMES = "^(ASCII_TOKEN|BOAT_[A-Z0-9_]+)=";
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

  step("execute: identity, env, argv check, env file gone, tunnel, marker file");
  const sentinel = `sentinel-${stamp}`;
  const run1 = await exec(
    lease1,
    'echo "user=$(id -un) uid=$(id -u)"; echo "env_ok=${SMOKE_SENTINEL:+yes}"; ' +
      // The sentinel value must not appear in any process argv (grep reads it from a file).
      'printenv SMOKE_SENTINEL > /tmp/.smoke-s; echo "in_argv=$(ps -eo args | grep -c -F -f /tmp/.smoke-s)"; ' +
      // The staged env file must already be gone when the command runs: not in /tmp, and never in the
      // workspace or anywhere under /home (boat snapshots save /home/user, not /tmp).
      'echo "env_files=$(timeout 60 grep -rlF -f /tmp/.smoke-s /tmp "$HOME" 2>/dev/null | grep -v -c "^/tmp/.smoke-s$")"; rm -f /tmp/.smoke-s; ' +
      'echo "env_dirs=$(ls -d /tmp/paperclip-boat-env-* 2>/dev/null | wc -l)"; ' +
      // Default-deny env and boat's own credentials. ${VAR+set} never prints a value.
      'echo "denied_env=${PLANETSCALE_SMOKE_URL+set}${SMOKE_DENIED+set}"; ' +
      'echo "ascii_token=${ASCII_TOKEN+set} boat_id=${BOAT_ID+set}"; ' +
      'echo "bashrc_ascii_token=$(grep -c "^[[:space:]]*export[[:space:]][[:space:]]*ASCII_TOKEN=" "$HOME/.bashrc" 2>/dev/null)"; ' +
      // No parent process may keep boat's tokens in its startup environment: the login shell and the
      // command script exec, so the parent is sshd. Counts names only, never values.
      `n=$(tr "\\000" "\\n" < /proc/$PPID/environ 2>/dev/null | grep -c -E "${BOAT_TOKEN_NAMES}"); echo "ppid_environ_tokens=\${n:-0}"; ` +
      'echo "ppid_environ_readable=$([ -r /proc/$PPID/environ ] && echo yes || echo no) ppid_comm=$(cat /proc/$PPID/comm 2>/dev/null)"; ' +
      // Every ancestor this user can read, up to pid 1.
      `p=$PPID; hits=0; seen=0; while [ "\${p:-0}" -gt 1 ]; do if [ -r /proc/$p/environ ]; then seen=$((seen+1)); if tr "\\000" "\\n" < /proc/$p/environ | grep -q -E "${BOAT_TOKEN_NAMES}"; then hits=$((hits+1)); fi; fi; p=$(sed "s/.*) //" /proc/$p/stat 2>/dev/null | cut -d" " -f2); done; echo "ancestor_environ_tokens=$hits readable_ancestors=$seen"; ` +
      `n=$(grep -c -E "^[[:space:]]*(export[[:space:]]+)?(ASCII_TOKEN|BOAT_[A-Z0-9_]+)=" /etc/environment 2>/dev/null); echo "etc_environment_tokens=\${n:-0}"; ` +
      // Acquire linked .paperclip-runtime into /tmp (never snapshotted). Evidence: where it points, and what /tmp is.
      'l="$HOME/paperclip-workspace/.paperclip-runtime"; t=$(readlink "$l"); case "$t" in /tmp/paperclip-boat-runtime-*) [ -L "$l" ] && [ -d "$t" ] && echo "runtime_link=tmp";; *) echo "runtime_link=bad";; esac; ' +
      'echo "tmp_fs=$(stat -f -c %T /tmp) tmp_free_kb=$(df -Pk /tmp | awk "NR==2{print \\$4}") runtime_target=$t"; ' +
      // Stand-in for Paperclip's mcp-config runtime asset (it holds the run JWT), written the way Paperclip
      // writes it, through the link: it must never reach /home, and the resumed disk must not have it.
      'rt="$HOME/paperclip-workspace/.paperclip-runtime/claude"; mkdir -p "$rt/mcp-config" "$rt/skills" && ' +
      'printf "{\\"mcpServers\\":{\\"smoke\\":{\\"headers\\":{\\"Authorization\\":\\"Bearer smoke-not-a-jwt\\"}}}}" > "$rt/mcp-config/mcp-config.json" && ' +
      'echo smoke > "$rt/mcp-config-upload.tar" && echo skill > "$rt/skills/smoke.md" && echo "planted_mcp_config=yes"; ' +
      'echo "planted_on_home_disk=$(timeout 60 grep -rlF smoke-not-a-jwt "$HOME" 2>/dev/null | wc -l)"; ' +
      'echo "tunnel_http=$(curl -s -o /dev/null -m 5 -w %{http_code} http://127.0.0.1:8317/ || echo fail)"; ' +
      'echo warm > "$HOME/paperclip-workspace/.smoke-marker"',
    { SMOKE_SENTINEL: sentinel, SMOKE_DENIED: "not-allowlisted", PLANETSCALE_SMOKE_URL: "mysql://u:p@example.invalid/db" },
  );
  const lines1 = run1.stdout.split("\n");
  for (const expected of [
    "env_ok=yes",
    "in_argv=0",
    "env_files=0",
    "env_dirs=0",
    "denied_env=",
    "ascii_token= boat_id=",
    "bashrc_ascii_token=0",
    "ppid_environ_tokens=0",
    "etc_environment_tokens=0",
    "runtime_link=tmp",
    "planted_mcp_config=yes",
    "planted_on_home_disk=0",
  ]) {
    if (!lines1.includes(expected)) throw new Error(`smoke check failed: expected ${expected}`);
  }
  if (!lines1.some((line) => line.startsWith("ancestor_environ_tokens=0 "))) throw new Error("smoke check failed: expected ancestor_environ_tokens=0");

  step("execute: a payload killed by SIGTERM reports 143 (ssh would say 255 if the payload replaced every shell)");
  const killed = await exec(lease1, "kill -TERM $$");
  if (killed.exitCode !== 143) throw new Error(`smoke check failed: expected exit 143 for SIGTERM, got ${killed.exitCode}`);

  step("release run 1 (stop)");
  console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease1.metadata }, "release")));

  step("acquire run 2 (resume the same card VM)");
  const lease2 = await manager.acquire({ ...base, runId: `smoke-run-2-${stamp}`, executionWorkspaceId: workspace, issueId: null });
  console.log(JSON.stringify(lease2.metadata));
  if (lease2.providerLeaseId !== sandboxId) throw new Error("expected the same VM on resume");
  if (lease2.metadata?.runtimeDir === lease1.metadata?.runtimeDir) throw new Error("expected a fresh runtime directory after the resume");
  const run2 = await exec(
    lease2,
    'cat "$HOME/paperclip-workspace/.smoke-marker"; rt="$HOME/paperclip-workspace/.paperclip-runtime/claude"; ' +
      'echo "mcp_config=$([ -e "$rt/mcp-config" ] && echo present || echo gone) upload_tar=$([ -e "$rt/mcp-config-upload.tar" ] && echo present || echo gone) skills=$([ -e "$rt/skills/smoke.md" ] && echo present || echo gone)"; ' +
      'echo "runtime_link_now=$(readlink "$HOME/paperclip-workspace/.paperclip-runtime")"',
  );
  // The whole runtime directory lived in /tmp, which the stop snapshot does not save; the rest of the disk is kept.
  // Paperclip syncs the runtime assets again for every run.
  for (const expected of ["warm", "mcp_config=gone upload_tar=gone skills=gone", `runtime_link_now=${lease2.metadata?.runtimeDir}`]) {
    if (!run2.stdout.split("\n").includes(expected)) throw new Error(`smoke check failed: expected ${expected}`);
  }

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
