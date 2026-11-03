// Cancellation-registry safety: the production python cancel command must
// refuse stale, unsafe, malformed, oversized, and locked records without
// signalling or unlinking. Real process groups and real record files; no SSH.
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cancelRemoteCommand, finalizeRemoteCommand } from "./shell.js";

const children: ChildProcess[] = [];
const records: string[] = [];

// Records live in a per-test directory, never host /tmp: the cancel script
// may leave an admission tombstone behind by design, and removing the whole
// directory in afterEach collects it with everything else.
let recordDir = "";

beforeEach(async () => {
  recordDir = await mkdtemp(path.join(tmpdir(), "paperclip-boat-registry-"));
});

afterEach(async () => {
  // Reap every owned process even when an assertion failed (mutant RED).
  for (const child of children.splice(0)) {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }
  for (const record of records.splice(0)) {
    await rm(record, { force: true });
  }
  await rm(recordDir, { recursive: true, force: true });
});

function newRunId(): string {
  return randomUUID().replace(/-/g, "");
}

function recordPath(runId: string): string {
  return path.join(recordDir, `paperclip-boat-run-${runId}`);
}

function procIdentity(pid: number): { running: boolean; group: number | null; start: string | null } {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { running: fields[0] !== "Z", group: Number(fields[2]), start: fields[19] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { running: false, group: null, start: null };
    throw error;
  }
}

function spawnOwnedGroup(): { child: ChildProcess; pid: number; start: string } {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  if (!child.pid) throw new Error("owned sleep did not start");
  children.push(child);
  const identity = procIdentity(child.pid);
  const runner = procIdentity(process.pid);
  if (!identity.running || !identity.start) throw new Error("owned group never became observable");
  if (!identity.group || identity.group <= 1 || identity.group === runner.group) {
    throw new Error("unsafe owned process group");
  }
  return { child, pid: child.pid, start: identity.start };
}

function runCancel(runId: string) {
  const command = cancelRemoteCommand(runId, recordDir);
  expect(command).toContain(recordPath(runId));
  return spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 8000 });
}

function runFinalize(runId: string) {
  const command = finalizeRemoteCommand(runId, recordDir);
  expect(command).toContain(recordPath(runId));
  return spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 8000 });
}

async function writeRecord(runId: string, body: string, mode = 0o600): Promise<string> {
  const record = recordPath(runId);
  await writeFile(record, body, { mode });
  records.push(record);
  return record;
}

it("stale identity is refused; the unrelated owned group keeps running and the record is untouched", async () => {
  const runId = newRunId();
  const { pid, start } = spawnOwnedGroup();
  const record = await writeRecord(runId, JSON.stringify({ pgid: pid, start: "-1" }));
  const before = await readFile(record, "utf8");

  const result = runCancel(runId);

  expect(result.status, `refuse stale identity, stderr: ${result.stderr}`).not.toBe(0);
  expect(result.stderr).toMatch(/identity changed/i);
  expect(procIdentity(pid).running, "unrelated owned process must keep running").toBe(true);
  expect(procIdentity(pid).start, "same process, not a recycled PID").toBe(start);
  expect(existsSync(record), "stale record must not be unlinked").toBe(true);
  expect(await readFile(record, "utf8"), "stale record must be byte-identical").toBe(before);
});

it("unsafe record mode is refused; the owned group keeps running and the record is untouched", async () => {
  const runId = newRunId();
  const { pid, start } = spawnOwnedGroup();
  const record = await writeRecord(runId, JSON.stringify({ pgid: pid, start }));
  await chmod(record, 0o644);
  const before = await readFile(record, "utf8");

  const result = runCancel(runId);

  expect(result.status, `refuse unsafe mode, stderr: ${result.stderr}`).not.toBe(0);
  expect(result.stderr).toMatch(/unsafe/i);
  expect(procIdentity(pid).running).toBe(true);
  expect(procIdentity(pid).start).toBe(start);
  expect(existsSync(record)).toBe(true);
  expect(await readFile(record, "utf8")).toBe(before);
  expect(statSync(record).mode & 0o777, "mode must be untouched").toBe(0o644);
});

it("malformed JSON record is refused with a diagnostic and left untouched", async () => {
  const runId = newRunId();
  const record = await writeRecord(runId, "{broken");
  const before = await readFile(record, "utf8");

  const result = runCancel(runId);

  expect(result.status, `refuse malformed JSON, stderr: ${result.stderr}`).not.toBe(0);
  expect(result.stderr.trim().length, "a diagnostic must be printed").toBeGreaterThan(0);
  expect(existsSync(record)).toBe(true);
  expect(await readFile(record, "utf8")).toBe(before);
});

it("non-dict record is refused with a diagnostic and left untouched", async () => {
  const runId = newRunId();
  const record = await writeRecord(runId, "[]");
  const before = await readFile(record, "utf8");

  const result = runCancel(runId);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/invalid/i);
  expect(existsSync(record)).toBe(true);
  expect(await readFile(record, "utf8")).toBe(before);
});

it("oversized record is refused with a diagnostic and left untouched", async () => {
  const runId = newRunId();
  const record = await writeRecord(runId, "x".repeat(2048));
  const before = await readFile(record, "utf8");

  const result = runCancel(runId);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/oversized/i);
  expect(existsSync(record)).toBe(true);
  expect(await readFile(record, "utf8")).toBe(before);
});

it("locked record times out with a diagnostic and is left untouched", async () => {
  const runId = newRunId();
  const { pid } = spawnOwnedGroup();
  const start = procIdentity(pid).start!;
  const record = await writeRecord(runId, JSON.stringify({ pgid: pid, start }));
  const before = await readFile(record, "utf8");
  const ready = path.join(recordDir, `paperclip-boat-lock-ready-${runId}`);
  const holder = spawn(
    "python3",
    ["-c", `import fcntl, pathlib, time; f = open(${JSON.stringify(record)}, 'r+'); fcntl.flock(f, fcntl.LOCK_EX); pathlib.Path(${JSON.stringify(ready)}).write_text('held'); time.sleep(6)`],
    { stdio: "ignore" },
  );
  children.push(holder);
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error("lock holder never acquired the record lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const result = runCancel(runId);

  expect(result.status, `refuse locked record, stderr: ${result.stderr}`).not.toBe(0);
  expect(result.stderr).toMatch(/lock.*timed out/i);
  expect(procIdentity(pid).running).toBe(true);
  expect(existsSync(record)).toBe(true);
  expect(await readFile(record, "utf8")).toBe(before);
}, 15000);

it("finalize removes a valid record without signalling the owned group", async () => {
  const runId = newRunId();
  const { pid, start } = spawnOwnedGroup();
  const record = await writeRecord(runId, JSON.stringify({ pgid: pid, start }));

  const result = runFinalize(runId);

  expect(result.status, `accept valid record, stderr: ${result.stderr}`).toBe(0);
  expect(existsSync(record), "finalize removes its record").toBe(false);
  expect(procIdentity(pid).running, "finalize must not signal the group").toBe(true);
  expect(procIdentity(pid).start, "same process, not a recycled PID").toBe(start);
});

it("control: a fresh valid record is accepted and the owned group is cancelled", async () => {
  const runId = newRunId();
  const { pid } = spawnOwnedGroup();
  const start = procIdentity(pid).start!;
  const record = await writeRecord(runId, JSON.stringify({ pgid: pid, start }));

  const result = runCancel(runId);

  expect(result.status, `accept valid record, stderr: ${result.stderr}`).toBe(0);
  expect(procIdentity(pid).running, "valid cancellation must stop the owned group").toBe(false);
  expect(existsSync(record), "valid cancellation removes its record").toBe(false);
});

it("cancel before admission leaves its tombstone in the record directory, not /tmp", async () => {
  const runId = newRunId();
  const record = recordPath(runId);
  records.push(record);

  const result = runCancel(runId);

  expect(result.status, `admission revocation, stderr: ${result.stderr}`).toBe(0);
  expect(existsSync(record), "the tombstone is kept for the delayed invocation").toBe(true);
  expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ cancelled: true });
  expect(existsSync(`/tmp/paperclip-boat-run-${runId}`), "nothing is written to host /tmp").toBe(false);
});
