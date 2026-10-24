// Test-owned payloads and cleanup only. No ambient environments are read.
import { existsSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "../shell.js";
import { waitFor } from "./local-sync-ssh.js";

function stat(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid owned PID");
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { running: fields[0] !== "Z", group: Number(fields[2]), start: fields[19] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

export class OwnedRemoteWork {
  readonly shellPid: string;
  readonly childPid: string;
  readonly ready: string;
  readonly late: string;
  readonly scheduled: string;
  private group?: { id: number; pid: number; start: string };

  constructor(readonly root: string) {
    this.shellPid = path.join(root, "remote-shell.pid");
    this.childPid = path.join(root, "remote-child.pid");
    this.ready = path.join(root, "remote-ready");
    this.late = path.join(root, "late-write");
    this.scheduled = path.join(root, "scheduled-ms");
  }

  command(output = ":") {
    // Install ignored graceful signals BEFORE publishing readiness. This child
    // requires bounded escalation, and retains its process group if SSH exits.
    const child = `import os, pathlib, signal, time
for sig in [signal.SIGHUP, signal.SIGTERM, signal.SIGINT]: signal.signal(sig, signal.SIG_IGN)
pathlib.Path(${JSON.stringify(this.childPid)}).write_text(str(os.getpid()))
pathlib.Path(${JSON.stringify(this.ready)}).write_text('ready')
while not pathlib.Path(${JSON.stringify(this.scheduled)}).exists(): time.sleep(.005)
due = float(pathlib.Path(${JSON.stringify(this.scheduled)}).read_text()) / 1000
time.sleep(max(0, due - time.time()))
pathlib.Path(${JSON.stringify(this.late)}).write_text('DUMMY_LATE_WRITE')
while True: time.sleep(30)
`;
    return `printf '%s' $$ > ${shellQuote(this.shellPid)}; python3 -c ${shellQuote(child)} & ` +
      `while [ ! -f ${shellQuote(this.ready)} ]; do sleep .01; done; ${output}; wait`;
  }

  snapshot() {
    const running = (file: string) => existsSync(file) && !!stat(Number(readFileSync(file, "utf8")))?.running;
    return { shell: running(this.shellPid), descendant: running(this.childPid) };
  }

  async started() {
    await waitFor(() => existsSync(this.ready), "owned remote descendant never became ready");
    this.rememberGroup();
  }

  private rememberGroup() {
    if (this.group) return;
    for (const file of [this.childPid, this.shellPid]) {
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8"));
      const identity = stat(pid);
      if (!identity) continue;
      // A detached remote group must never be the local runner's group.
      if (identity.group <= 1 || identity.group === stat(process.pid)?.group) throw new Error("unsafe owned process group");
      this.group = { id: identity.group, pid, start: identity.start };
      return;
    }
  }

  async pastScheduledWrite() {
    // Arm the delayed side effect only AFTER the caller observed completion.
    // This proves no post-return work without imposing an arbitrary shorter
    // cancellation budget (or confusing pre-rejection writes with regressions).
    const due = Date.now() + 1000;
    await writeFile(`${this.scheduled}.tmp`, String(due));
    await rename(`${this.scheduled}.tmp`, this.scheduled);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due + 200 - Date.now())));
    return existsSync(this.late);
  }

  async cleanup() {
    this.rememberGroup();
    if (this.group && stat(this.group.pid)?.start === this.group.start) {
      try { process.kill(-this.group.id, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await waitFor(() => !this.snapshot().shell && !this.snapshot().descendant, "owned remote payload survived teardown");
  }
}

export async function stopGateWorker(root: string) {
  const file = path.join(root, "worker.json");
  if (!existsSync(file)) return;
  const identity = JSON.parse(await readFile(file, "utf8")) as { pid: number; start: string };
  const current = stat(identity.pid);
  if (!current || current.start !== identity.start) return;
  if (current.group !== identity.pid || current.group === stat(process.pid)?.group) throw new Error("unsafe gate worker group");
  try { process.kill(-identity.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await waitFor(() => !stat(identity.pid)?.running, "gate worker survived teardown");
}
