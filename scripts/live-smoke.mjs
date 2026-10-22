#!/usr/bin/env node
// Live smoke test against the real boat API, through the plugin's own code
// (dist/vm-manager.js + the official @boatdev/sdk). Costs 1-3 starts and a few
// minutes of a `small` VM (about $0.001). Leaves nothing behind: the VM is
// deleted at the end, also on failure.
//
// It checks, among others: an allowlisted key arrives and denied keys do not;
// the env file is gone before the command runs; boat's ASCII_TOKEN/BOAT_* are
// in neither the command's env, ~/.bashrc, /etc/environment, nor the startup
// environ of its parent or any readable ancestor; the workspace's
// .paperclip-runtime is a symlink into /tmp, so a stand-in for Paperclip's run
// MCP config written through it never reaches /home, is in no snapshot of the
// VM (per-minute or stop; read with GET /snapshots/{id}/tree), and is gone
// after a stop and resume; and a payload killed by SIGTERM exits 143, not 255.
//
// A resume within 10 minutes of a stop gets the same machine back, /tmp
// included (docs.boat.dev/snapshots/stop), so the runtime link is kept. With
// SMOKE_NEW_MACHINE=1 the smoke also waits out those 10 unbilled minutes and
// resumes once more: that restores the snapshot on a new machine, whose /tmp is
// empty, and the plugin must make a fresh runtime directory (one more start).
//
// Usage (key from stdin or BOAT_API_KEY; never put it in argv):
//   read -rs BOAT_API_KEY; export BOAT_API_KEY; node scripts/live-smoke.mjs
// Options (env): SMOKE_TUNNEL_HOST (default 127.0.0.1), SMOKE_TUNNEL_PORT (8317), SMOKE_SIZE (small), SMOKE_NEW_MACHINE (unset)
import { createSdkBoatApi } from "../dist/boat-client.js";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sdk = createSdkBoatApi({ apiKey: process.env.BOAT_API_KEY, apiBase: process.env.BOAT_API_BASE ?? "https://boat.dev/api/v1" });

/** Every snapshot boat holds for the VM, with what its file tree says about the runtime directory. */
async function snapshotTrees(id) {
  const list = await sdk.listSandboxSnapshots({ sandboxId: id, limit: 50 });
  const out = [];
  for (const snapshot of list.snapshots ?? []) {
    if (snapshot.status !== "ready" && snapshot.status !== "completed") {
      out.push({ id: snapshot.id, kind: snapshot.kind ?? null, status: snapshot.status, tree: "not ready" });
      continue;
    }
    const tree = await sdk.getSnapshotTree({ snapshotId: snapshot.id });
    const entries = tree.entries ?? [];
    // Tree paths are relative to the snapshot root, /home/user for the home folder ("paperclip-workspace/...").
    const link = entries.find((entry) => /(^|\/)paperclip-workspace\/\.paperclip-runtime$/.test(entry.path));
    out.push({
      id: snapshot.id,
      kind: snapshot.kind ?? null,
      createdAt: snapshot.createdAt,
      treeAvailable: tree.treeAvailable,
      truncated: tree.truncated,
      entries: entries.length,
      tmpRuntimeEntries: entries.filter((entry) => entry.path.includes("paperclip-boat-runtime-")).length,
      mcpConfigEntries: entries.filter((entry) => /\.paperclip-runtime\/[^/]+\/mcp-config/.test(entry.path)).length,
      runtimeLinkKind: link?.kind ?? null,
      marker: entries.some((entry) => entry.path.endsWith("paperclip-workspace/.smoke-marker")),
    });
  }
  return out;
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

  // boat takes its per-minute snapshots on its own schedule (one run got the first after 46 s, another
  // none in 81 s), so wait until one exists while the stand-in is in place, up to 4 minutes.
  step("wait until boat has taken a snapshot of the running VM with the stand-in in place (up to 240 s)");
  let runningSnapshots = 0;
  for (let waited = 0; waited <= 240_000 && runningSnapshots === 0; waited += 10_000) {
    if (waited > 0) await sleep(10_000);
    const list = await sdk.listSandboxSnapshots({ sandboxId, limit: 50 });
    runningSnapshots = (list.snapshots ?? []).filter((snapshot) => snapshot.status === "completed").length;
  }
  console.log(`running_snapshots=${runningSnapshots}`);
  if (runningSnapshots === 0) console.log("warning: boat took no snapshot of the running VM within 240 s; only the stop snapshot is checked below");

  step("release run 1 (stop)");
  console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease1.metadata }, "release")));

  step("snapshots: none holds the /tmp runtime directory or an MCP config (GET /snapshots/{id}/tree)");
  const trees = await snapshotTrees(sandboxId);
  console.log(JSON.stringify(trees));
  const read = trees.filter((tree) => typeof tree.entries === "number");
  if (read.length < Math.min(2, runningSnapshots + 1)) throw new Error(`smoke check failed: expected ${runningSnapshots > 0 ? "a running and a stop snapshot" : "the stop snapshot"}, read ${read.length}`);
  if (read.some((tree) => tree.tmpRuntimeEntries > 0 || tree.mcpConfigEntries > 0)) throw new Error("smoke check failed: a snapshot holds the runtime directory");
  if (!read.some((tree) => tree.marker)) throw new Error("smoke check failed: no snapshot tree shows the workspace marker (tree not covering /home?)");
  // The snapshots hold the link itself, never what it points at.
  if (!read.some((tree) => tree.runtimeLinkKind === "symlink") || read.some((tree) => tree.runtimeLinkKind != null && tree.runtimeLinkKind !== "symlink")) {
    throw new Error("smoke check failed: expected .paperclip-runtime as a symlink in the snapshot trees");
  }

  // Within 10 minutes of the stop boat gives the same machine back, /tmp included: the link is kept, and
  // the scrub before the stop already removed the stand-in MCP config. On a new machine /tmp is empty.
  const checkRuntimeAfterResume = async (lease, label) => {
    const run = await exec(
      lease,
      'cat "$HOME/paperclip-workspace/.smoke-marker"; rt="$HOME/paperclip-workspace/.paperclip-runtime/claude"; ' +
        'echo "mcp_config=$([ -e "$rt/mcp-config" ] && echo present || echo gone) upload_tar=$([ -e "$rt/mcp-config-upload.tar" ] && echo present || echo gone)"; ' +
        'echo "skills=$([ -e "$rt/skills/smoke.md" ] && echo present || echo gone)"; ' +
        'echo "runtime_link_now=$(readlink "$HOME/paperclip-workspace/.paperclip-runtime")"',
    );
    for (const expected of ["warm", "mcp_config=gone upload_tar=gone", `runtime_link_now=${lease.metadata?.runtimeDir}`]) {
      if (!run.stdout.split("\n").includes(expected)) throw new Error(`smoke check failed (${label}): expected ${expected}`);
    }
    return run.stdout.split("\n").find((line) => line.startsWith("skills=")) ?? "";
  };

  step("acquire run 2 (resume the same card VM within 10 minutes: the same machine)");
  const lease2 = await manager.acquire({ ...base, runId: `smoke-run-2-${stamp}`, executionWorkspaceId: workspace, issueId: null });
  console.log(JSON.stringify(lease2.metadata));
  if (lease2.providerLeaseId !== sandboxId) throw new Error("expected the same VM on resume");
  const sameMachine = lease2.metadata?.runtimeDir === lease1.metadata?.runtimeDir;
  const skills2 = await checkRuntimeAfterResume(lease2, "run 2");
  console.log(`runtime_dir_after_quick_resume=${sameMachine ? "kept (same machine)" : "fresh (new machine)"} ${skills2}`);
  if (sameMachine && skills2 !== "skills=present") throw new Error("smoke check failed: a kept runtime directory lost its files");

  step("release run 2 (stop)");
  console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease2.metadata }, "release")));

  if (process.env.SMOKE_NEW_MACHINE === "1") {
    step("wait 11 minutes (boat keeps the stopped machine 10 minutes, unbilled), then resume on a new machine");
    await sleep(11 * 60_000);
    const lease3 = await manager.acquire({ ...base, runId: `smoke-run-3-${stamp}`, executionWorkspaceId: workspace, issueId: null });
    console.log(JSON.stringify(lease3.metadata));
    if (lease3.metadata?.runtimeDir === lease2.metadata?.runtimeDir) throw new Error("smoke check failed: expected a fresh runtime directory on a new machine");
    const skills3 = await checkRuntimeAfterResume(lease3, "run 3");
    if (skills3 !== "skills=gone") throw new Error("smoke check failed: the new machine's /tmp still had the old runtime files");
    console.log("runtime_dir_after_new_machine_resume=fresh skills=gone");
    step("release run 3 (stop)");
    console.log(JSON.stringify(await manager.release({ ...base, providerLeaseId: sandboxId, leaseMetadata: lease3.metadata }, "release")));
  }

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
