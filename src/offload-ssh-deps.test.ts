import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshOffloadSync } from "./offload-ssh-sync.js";
import { guestPythonUserBase } from "./offload/guest-toolchain.js";
import type { OffloadCommand } from "./offload.js";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boat-sync-deps-"));
  tmpdirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) writeFileSync(path.join(dir, rel), contents);
  return dir;
}

function command(over: Partial<OffloadCommand> = {}): OffloadCommand {
  return {
    commandId: "7d82278c-2ba7-4e68-96ab-a2cc10b697af",
    companyId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    cardId: "",
    repoId: "repo:https://github.com/example/app",
    profileId: "node-public-1",
    tool: "node",
    runner: "npm",
    argv: ["run", "test"],
    cwdRelative: ".",
    env: {},
    ...over,
  };
}

function setup(root: string) {
  const calls: string[] = [];
  let markerExists = false;
  const ssh = {
    runStream: vi.fn(async (_session: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("test -f")) return { exitCode: markerExists ? 0 : 1, timedOut: false, signal: null, stdout: "" };
      markerExists = true;
      return { exitCode: 0, timedOut: false, signal: null, stdout: "" };
    }),
  };
  const sync = new SshOffloadSync({
    ssh: ssh as never,
    session: async () => ({} as never),
    sourceRoot: async () => root,
    artifactRoot: root,
    workRoot: "/tmp/boat-test",
  });
  return { sync, ssh, calls };
}

describe("installDependencies", () => {
  it("skips cargo checkouts entirely", async () => {
    const { sync, ssh } = setup(source({}));
    await sync.installDependencies("vm-1", command({ tool: "cargo", profileId: "rust-public-1" }), source({}), "/tmp/guest");
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("refuses an unlocked manifest instead of installing", async () => {
    const { sync } = setup(source({ "package.json": "{}" }));
    await expect(sync.installDependencies("vm-1", command(), source({ "package.json": "{}" }), "/tmp/guest"))
      .rejects.toThrow(/lockfile/i);
  });

  it("reuses the shared cache for global pip installs", async () => {
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    const root = source({ "requirements.txt": pinned });
    const py = command({ tool: "python", runner: "pytest", profileId: "python-public-1", argv: ["tests/"] });
    const { sync, ssh, calls } = setup(root);
    await sync.installDependencies("vm-1", py, root, "/guest/work");
    expect(ssh.runStream).toHaveBeenCalledTimes(2); // marker check + install
    expect(calls[1]).toContain("pip");
    expect(calls[1]).toContain("--require-hashes");
    // A pip user-site fallback must land where the command (fresh HOME) reads
    // it: the per-VM PYTHONUSERBASE, never the SSH session's home.
    expect(calls[1]).toContain("PYTHONUSERBASE=");
    expect(calls[1]).toContain(guestPythonUserBase("/tmp/boat-test", "vm-1"));
    const before = ssh.runStream.mock.calls.length;
    await sync.installDependencies("vm-1", py, root, "/guest/work");
    expect(ssh.runStream.mock.calls.length).toBe(before); // in-memory cache
    await sync.installDependencies("vm-2", py, root, "/guest/work");
    expect(ssh.runStream.mock.calls.length).toBe(before + 1); // guest marker hit only
  });

  it("reinstalls checkout-local deps per guest checkout on a warm VM", async () => {
    const root = source({ "package-lock.json": "{}" });
    const { sync, ssh } = setup(root);
    await sync.installDependencies("vm-1", command(), root, "/guest/work-cmd1");
    const afterFirst = ssh.runStream.mock.calls.length;
    // Warm VM, same lockfile hash, different per-command checkout: must reinstall.
    await sync.installDependencies("vm-1", command(), root, "/guest/work-cmd2");
    expect(ssh.runStream.mock.calls.length).toBeGreaterThan(afterFirst);
    const lastInstall = ssh.runStream.mock.calls.map((c) => String(c[1])).filter((c) => !c.includes("test -f")).pop()!;
    expect(lastInstall).toContain("/guest/work-cmd2");
    expect(lastInstall).toContain("npm");
  });

  it("fails the push when the install fails", async () => {
    const root = source({ "requirements.txt": "pytest==7.4.2 \\\n    --hash=sha256:abc123\n" });
    const ssh = {
      runStream: vi.fn(async (_s: unknown, cmd: string) => {
        if (String(cmd).includes("test -f")) return { exitCode: 1, timedOut: false, signal: null, stdout: "" };
        return { exitCode: 1, timedOut: false, signal: null, stdout: "pip exploded" };
      }),
    };
    const sync = new SshOffloadSync({ ssh: ssh as never, session: async () => ({} as never),
      sourceRoot: async () => root, artifactRoot: root, workRoot: "/tmp/boat-test" });
    await expect(sync.installDependencies("vm-1",
      command({ tool: "python", runner: "pytest", profileId: "python-public-1", argv: ["tests/"] }), root, "/guest/work"))
      .rejects.toThrow(/install failed/i);
  });
});
