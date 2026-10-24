#!/usr/bin/env node
// Authorized operator only, after exact-head CI/review. Creates ONE fresh VM,
// uses the real plugin hooks, stops it on release, then deletes only that VM.
// Key: BOAT_API_KEY (env only). Optional: SMOKE_SIZE=small|default and
// SMOKE_TEMPLATE_SNAPSHOT (an existing approved snapshot, never a new capture).
// Run: npm run build && node scripts/native-sync-smoke.mjs
// Redirect stdout to the run log. No model call, real credentials in fixtures,
// production workspace, plugin activation, or environment-policy change.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import plugin from "../dist/plugin.js";

if (!process.env.BOAT_API_KEY || !process.env.PAPERCLIP_RUN_SCRATCH_DIR) {
  console.error("BOAT_API_KEY and PAPERCLIP_RUN_SCRATCH_DIR must be set; no VM started.");
  process.exit(2);
}
const size = process.env.SMOKE_SIZE ?? "small";
assert.ok(["small", "default"].includes(size), "Use only an approved trial size.");
const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, "native-smoke-"));
const stamp = Date.now().toString(36);
const remoteRoot = `/home/user/native-sync-smoke-${stamp}`;
const inputBytes = 46_400_000;
const outputBytes = 36_900_000;
const input = path.join(root, "input.bin");
const output = path.join(root, "output.bin");
const event = (name, details = {}) => console.log(JSON.stringify({ event: name, at: new Date().toISOString(), monotonicMs: performance.now(), ...details }));
const state = new Map();
const stateKey = (key) => `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? ""}|${key.stateKey}`;
await plugin.definition.setup({
  state: {
    get: async (key) => structuredClone(state.get(stateKey(key)) ?? null),
    set: async (key, value) => void state.set(stateKey(key), structuredClone(value)),
  },
  logger: Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message, metadata) => event("plugin_log", { level, message, metadata })])),
  issues: { get: async () => null },
  jobs: { register() {} },
});
const config = {
  size, namePrefix: `pcnativesmoke-${stamp}`, remoteWorkspaceDir: remoteRoot,
  cliproxyTunnel: false, autoStopMinutes: 5, timeoutMs: 120_000,
  ...(process.env.SMOKE_TEMPLATE_SNAPSHOT ? { templateSnapshot: process.env.SMOKE_TEMPLATE_SNAPSHOT } : {}),
};
const base = { driverKey: "boat", companyId: "native-smoke-company", environmentId: "native-smoke-env", config };
let lease;
let failed = false;
try {
  const handle = await open(input, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (let written = 0; written < inputBytes;) {
      const chunk = randomBytes(Math.min(64 * 1024, inputBytes - written));
      await handle.writeFile(chunk);
      hash.update(chunk);
      written += chunk.length;
    }
  } finally { await handle.close(); }
  const inputHash = hash.digest("hex");
  // Input generation is outside the billed interval.
  const acquireStarted = performance.now();
  event("lease_acquire_started", { inputBytes, outputBytes });
  lease = await plugin.definition.onEnvironmentAcquireLease({ ...base, runId: `native-smoke-${stamp}`, executionWorkspaceId: `native-smoke-${stamp}` });
  assert.ok(lease.providerLeaseId);
  const acquiredAt = performance.now();
  event("lease_acquired", { sandboxId: lease.providerLeaseId });
  const inbound = await plugin.definition.onEnvironmentSyncIn({ ...base, lease, operations: [{ operationId: "upload", files: [
    { sourcePath: input, targetPath: `${remoteRoot}/input.bin`, kind: "file", mode: 0o600 },
  ] }] });
  assert.deepEqual(inbound, { operations: [{ operationId: "upload", filesTransferred: 1, bytesTransferred: inputBytes }] });
  event("cli_dispatch");
  const result = await plugin.definition.onEnvironmentExecute({
    ...base, lease, command: "python3", timeoutMs: 120_000,
    args: ["-c", `import hashlib,json,os,sys,time
start=time.monotonic()
print(json.dumps({'event':'cli_start','atUnix':time.time()}),flush=True)
root=sys.argv[1]
h=hashlib.sha256()
with open(root+'/input.bin','rb') as source:
    while True:
        chunk=source.read(65536)
        if not chunk: break
        h.update(chunk)
assert h.hexdigest()==sys.argv[2], 'input digest mismatch'
out=hashlib.sha256()
fd=os.open(root+'/output.bin',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as target:
    remaining=int(sys.argv[3])
    while remaining:
        chunk=os.urandom(min(65536,remaining))
        target.write(chunk)
        out.update(chunk)
        remaining-=len(chunk)
print(json.dumps({'event':'cli_end','atUnix':time.time(),'durationMs':(time.monotonic()-start)*1000,'sha256':out.hexdigest()}),flush=True)
`, remoteRoot, inputHash, String(outputBytes)],
  });
  assert.equal(result.exitCode, 0, "CLI failed; contents/diagnostics are not logged.");
  assert.equal(result.timedOut, false);
  const markers = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(markers[0].event, "cli_start");
  const cli = markers.at(-1);
  assert.equal(cli.event, "cli_end");
  for (const marker of markers) event("remote_marker", marker);
  const outbound = await plugin.definition.onEnvironmentSyncOut({ ...base, lease, operations: [{ operationId: "download", files: [
    { sourcePath: `${remoteRoot}/output.bin`, targetPath: output, kind: "file", mode: 0o600 },
  ] }] });
  assert.deepEqual(outbound, { operations: [{ operationId: "download", filesTransferred: 1, bytesTransferred: outputBytes }] });
  const outputHash = createHash("sha256");
  for await (const chunk of createReadStream(output)) outputHash.update(chunk);
  assert.equal(outputHash.digest("hex"), cli.sha256);
  event("lease_release_started");
  const receipt = await plugin.definition.onEnvironmentReleaseLease({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
  assert.equal(receipt?.state, "stopped");
  const releasedAt = performance.now();
  event("lease_released", { state: receipt.state });
  // Subtract only the measured remote CLI duration, not SSH dispatch, profiles,
  // hashing, or return latency. This conservatively counts all non-CLI time as
  // staging and needs no clock synchronization between the host and VM.
  const stagingMs = releasedAt - acquiredAt - cli.durationMs;
  const withAcquireMs = releasedAt - acquireStarted - cli.durationMs;
  event("timing_result", { stagingMs, withAcquireMs, targetMs: 30_000, inputBytes, outputBytes, passed: stagingMs < 30_000 });
  assert.ok(stagingMs < 30_000, "Combined lease-to-CLI and CLI-to-release staging is not below 30 seconds.");
} catch (error) {
  failed = true;
  event("smoke_failed", { name: error?.name ?? "Error" });
} finally {
  if (lease?.providerLeaseId) {
    try {
      const receipt = await plugin.definition.onEnvironmentDestroyLease({ ...base, providerLeaseId: lease.providerLeaseId });
      assert.equal(receipt.state, "destroyed");
      event("smoke_vm_destroyed", { sandboxId: lease.providerLeaseId });
    } catch {
      failed = true;
      event("cleanup_failed", { sandboxId: lease.providerLeaseId, action: "Operator must delete only this smoke VM; do not retry with another credential." });
    }
  }
  await plugin.definition.onShutdown?.();
  await rm(root, { recursive: true, force: true });
  event(failed ? "smoke_not_accepted" : "smoke_accepted");
  process.exitCode = failed ? 1 : 0;
}
