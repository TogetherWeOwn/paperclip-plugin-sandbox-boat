#!/usr/bin/env node
// Measures the host-side cost of an unchanged-tree delta sync:
// capture the manifest twice (cold then warm page cache), plan the delta
// against the previous capture, and push the plan into a temp mirror with
// LocalGuestStore. Prints per-phase files/bytes/ms plus clock conditions.
//
// Usage: node scripts/measure-offload-sync.mjs <source-dir>
// Exit 2 when the warm capture+plan+push exceeds 1000 ms.
//
// This covers the host half of the acceptance ("a delta push of an unchanged
// two-bot-next tree takes 1 s or less on a warm VM"). The warm-VM rsync leg
// (zero files over the SSH control master) is measured separately once the
// executor wires the live transport; an empty --files-from push is one small
// round trip on top of the numbers below.
import { mkdtempSync } from "node:fs";
import { tmpdir, loadavg, cpus } from "node:os";
import path from "node:path";
import { captureManifest, planPush, LocalGuestStore } from "../dist/offload-sync.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/measure-offload-sync.mjs <source-dir>");
  process.exit(2);
}

const conditions = {
  at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: `${cpus().length}x ${cpus()[0]?.model ?? "unknown"}`,
  loadavg1m: loadavg()[0],
};

const cold = await captureManifest(dir);
const warmStart = Date.now();
const warm = await captureManifest(dir);
const warmCaptureMs = Date.now() - warmStart;
const planStart = Date.now();
const plan = planPush(cold.manifest, warm.manifest);
const planMs = Date.now() - planStart;
const mirror = mkdtempSync(path.join(tmpdir(), "offload-sync-measure-"));
const pushStart = Date.now();
const pushed = await new LocalGuestStore().push(mirror, plan.toSend, path.join(mirror, "guest"));
const pushMs = Date.now() - pushStart;
void pushed;

const report = {
  ...conditions,
  sourceDir: dir,
  files: warm.stats.files,
  bytes: warm.stats.bytes,
  coldCaptureMs: cold.stats.elapsedMs,
  warmCaptureMs,
  planMs,
  planToSend: plan.toSend.length,
  planToDelete: plan.toDeleteFromMirror.length,
  pushMs,
  warmTotalMs: warmCaptureMs + planMs + pushMs,
};
console.log(JSON.stringify(report, null, 2));

if (plan.toSend.length !== 0 || plan.toDeleteFromMirror.length !== 0) {
  console.error("expected an unchanged tree to plan zero files");
  process.exit(2);
}
if (report.warmTotalMs > 1000) {
  console.error(`warm capture+plan+push took ${report.warmTotalMs} ms, over the 1000 ms budget`);
  process.exit(2);
}
