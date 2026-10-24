// These checks catch credentials stripped only in the payload while a live
// supervisor still retains the startup environment in /proc/<pid>/environ.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildRemoteCommand, shellQuote, wrapRemoteCommand } from "./shell.js";
import { waitFor } from "./test-support/local-sync-ssh.js";

const dummyToken = "PUBLIC_FAKE_ASCII_TOKEN_ENVIRONMENT_CANARY";
const dummyBoat = "PUBLIC_FAKE_BOAT_ID_ENVIRONMENT_CANARY";

for (const supervised of [false, true]) {
  it(`${supervised ? "supervised" : "unsupervised"} payload and every live controlled ancestor have no credential startup bytes`, async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "credential-env-"));
    const pidFile = path.join(root, "payload.pid");
    const release = path.join(root, "release");
    const script = `import os, pathlib, time
pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))
while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.01)
`;
    const bare = buildRemoteCommand(`exec python3 -c ${shellQuote(script)}`);
    const command = supervised ? wrapRemoteCommand(bare, "public-environment-control") : bare;
    // Whitelist only dummy launch values, never inherit the runner's credentials.
    // The runner itself does NOT have either sentinel and is outside the boundary.
    const child = spawn("sh", ["-c", command], {
      env: { PATH: "/usr/bin:/bin", HOME: root, ASCII_TOKEN: dummyToken, BOAT_ID: dummyBoat, ORDINARY_VARIABLE: "ordinary-preserved" },
      detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.resume();
    const closed = once(child, "close");
    try {
      await waitFor(() => existsSync(pidFile), "controlled credential payload did not start");
      let pid = Number(await readFile(pidFile, "utf8"));
      let reachedLaunchBoundary = false;
      let inspected = 0;
      while (pid > 1 && inspected < 16) {
        expect(pid, "must never inspect the ambient test runner").not.toBe(process.pid);
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
        const environment = await readFile(`/proc/${pid}/environ`);
        const containsDummyCredential = environment.includes(dummyToken) || environment.includes(dummyBoat);
        // Output only the executable kind/depth and a boolean, never environment.
        expect.soft(containsDummyCredential, `controlled ${comm} at depth ${inspected} retains dummy credential startup bytes`).toBe(false);
        expect.soft(environment.includes("ORDINARY_VARIABLE=ordinary-preserved\0"), `controlled ${comm} lost an ordinary variable`).toBe(true);
        inspected++;
        if (pid === child.pid) { reachedLaunchBoundary = true; break; }
        pid = Number(fields[1]);
      }
      expect(inspected).toBeGreaterThanOrEqual(1);
      expect(reachedLaunchBoundary, "ancestor walk must end at the owned launcher, before runner/sshd").toBe(true);
      await writeFile(release, "release");
      expect((await closed)[0]).toBe(0);
    } finally {
      await writeFile(release, "release");
      // Payloads are gated, not unbounded sleeps. Kill only this owned launcher
      // group if an assertion/prerequisite interrupted the normal release.
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it(`${supervised ? "supervised" : "unsupervised"} command preserves ordinary variables and nonzero exit status`, () => {
    const bare = buildRemoteCommand('printf "%s" "$ORDINARY_VARIABLE"; exit 23');
    const command = supervised ? wrapRemoteCommand(bare, "public-status-control") : bare;
    const result = spawnSync("sh", ["-c", command], {
      env: { PATH: "/usr/bin:/bin", ASCII_TOKEN: dummyToken, BOAT_ID: dummyBoat, ORDINARY_VARIABLE: "ordinary-preserved" },
      encoding: "utf8", timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
    expect(result.stdout).toBe("ordinary-preserved");
  });
}
