#!/usr/bin/env node
// Offline only: writes a config patch to stdout, never updates an environment.
import { readFile } from "node:fs/promises";
import { recomputeSizeCostTable } from "../dist/size-policy.js";

const usage = "Usage: node scripts/recompute-size-cost-table.mjs <pilot.jsonl> [--now <ISO timestamp>]";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    if ((args.length !== 1 && args.length !== 3) || args[0].startsWith("--") || (args.length === 3 && args[1] !== "--now")) {
      throw new Error(usage);
    }
    const now = args.length === 3 ? Date.parse(args[2]) : Date.now();
    const text = await readFile(args[0], "utf8");
    const samples = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Invalid JSON in nonblank row ${index + 1}; fix the pilot log before refreshing.`); }
    });
    const sizeCostTable = recomputeSizeCostTable(samples, now);
    console.log(JSON.stringify({ sizeCostTable }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    code: error.code ?? "BOAT_COST_TABLE_REFRESH_FAILED",
    error: error.message,
    next_action: "Correct the pilot JSONL or arguments, then rerun. No environment was changed.",
  }));
  process.exitCode = 1;
}
