// Deterministically pause Path.write_text AFTER open/truncate, BEFORE write.
// Old fixture exposes an empty reached marker; atomic publication exposes none.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { waitFor } from "./test-support/local-sync-ssh.js";

it("gate marker existence implies complete valid count, even while writer is paused before its first byte", async () => {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "gate-publication-"));
  const pythonPath = path.join(root, "python");
  await mkdir(pythonPath);
  await writeFile(path.join(pythonPath, "sitecustomize.py"), String.raw`
import os, time
from pathlib import Path
original = Path.write_text
def paused_write(self, data, *args, **kwargs):
    if self.name.startswith('gate-reached'):
        with self.open('w', encoding='utf8') as stream:
            Path(os.environ['PUBLICATION_OPENED']).touch()
            deadline = time.monotonic() + 5
            while not Path(os.environ['PUBLICATION_RELEASE']).exists():
                if time.monotonic() > deadline:
                    raise RuntimeError('publication observer never released writer')
                time.sleep(0.005)
            return stream.write(data)
    return original(self, data, *args, **kwargs)
Path.write_text = paused_write
`);
  const reached = path.join(root, "gate-reached");
  const release = path.join(root, "gate-release");
  const opened = path.join(root, "publication-opened");
  const publish = path.join(root, "publication-release");
  const config = path.join(root, "relay.json");
  await writeFile(config, JSON.stringify({ root, command: "cat > /dev/null", gate: {
    direction: "in", afterBytes: 65536, reached, release,
  } }));
  const child = spawn("python3", [fileURLToPath(new URL("./test-support/local-sync-ssh.py", import.meta.url)), config], {
    stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: process.env.PATH, PYTHONPATH: pythonPath, PUBLICATION_OPENED: opened, PUBLICATION_RELEASE: publish,
    },
  });
  let diagnostic = "";
  child.stdout.resume();
  child.stderr.on("data", (bytes) => { diagnostic += String(bytes); });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  try {
    child.stdin.end(Buffer.alloc(128 * 1024, 0x91));
    await waitFor(() => existsSync(opened), "writer never reached deterministic open-before-write pause");
    const visibleDuringWrite = existsSync(reached);
    const partial = visibleDuringWrite ? await readFile(reached, "utf8") : null;
    // Release before asserting so failure cannot strand the fixture process.
    await writeFile(publish, "publish");
    await waitFor(() => existsSync(reached), "completed marker never published");
    const count = await readFile(reached, "utf8");
    await writeFile(release, "continue");
    expect(await closed, diagnostic).toBe(0);
    expect({ visibleDuringWrite, partial }, "marker must stay private until its whole count is written").toEqual({
      visibleDuringWrite: false, partial: null,
    });
    expect(count).toMatch(/^\d+$/);
    expect(Number(count)).toBeGreaterThanOrEqual(65536);
  } finally {
    await writeFile(publish, "publish");
    await writeFile(release, "continue");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
