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

  it("installs global pip deps with one RPC and no marker", async () => {
    const pinned = "pytest==7.4.2 \\\n    --hash=sha256:abc123\n";
    const root = source({ "requirements.txt": pinned });
    const py = command({ tool: "python", runner: "pytest", profileId: "python-public-1", argv: ["tests/"] });
    const { sync, ssh, calls } = setup(root);
    await sync.installDependencies("vm-1", py, root, "/guest/work");
    expect(ssh.runStream).toHaveBeenCalledTimes(1); // install only, no marker read
    expect(calls[0]).toContain("pip");
    expect(calls[0]).toContain("--require-hashes");
    expect(calls[0]).not.toContain("test -f");
    expect(calls[0]).not.toContain("touch");
    // A pip user-site fallback must land where the command (fresh HOME) reads
    // it: the per-VM PYTHONUSERBASE, never the SSH session's home.
    expect(calls[0]).toContain("PYTHONUSERBASE=");
    expect(calls[0]).toContain(guestPythonUserBase("/tmp/boat-test", "vm-1"));
    await sync.installDependencies("vm-1", py, root, "/guest/work");
    expect(ssh.runStream).toHaveBeenCalledTimes(1); // same hash reuses in memory
  });

  describe("pip active environment caching", () => {
    const pyCmd = () => command({ tool: "python", runner: "pytest", profileId: "python-public-1", argv: ["tests/"] });
    const reqs = (name: string) => source({ "requirements.txt": `pytest==${name === "a" ? "7.4.2" : "8.0.0"} \\\n    --hash=sha256:${name}\n` });
    type Result = { exitCode: number | null; timedOut: boolean; signal: string | null; stdout: string };
    const ok: Result = { exitCode: 0, timedOut: false, signal: null, stdout: "" };

    function build(root: string, results: Array<Result | Error> = []) {
      const queue = [...results];
      const ssh = {
        runStream: vi.fn(async () => {
          const next = queue.shift() ?? ok;
          if (next instanceof Error) throw next;
          return next;
        }),
      };
      const make = () => new SshOffloadSync({
        ssh: ssh as never,
        session: async () => ({} as never),
        sourceRoot: async () => root,
        artifactRoot: root,
        workRoot: "/tmp/boat-test",
      });
      return { ssh, make };
    }

    it("reinstalls A on a fresh worker despite historical A markers while B is active", async () => {
      const a = reqs("a");
      let active = "B";
      const ssh = { runStream: vi.fn(async (_session: unknown, script: string) => {
        // Historical A.ok exists, but B is installed. A marker check must not
        // authorize a cache hit; only actually installing A changes this state.
        if (script.includes("pip")) active = "A";
        return ok;
      }) };
      const fresh = new SshOffloadSync({ ssh: ssh as never, session: async () => ({} as never),
        sourceRoot: async () => a, artifactRoot: a, workRoot: "/tmp/boat-test" });
      await fresh.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      expect(active).toBe("A");
      expect(ssh.runStream).toHaveBeenCalledTimes(1);
      expect(ssh.runStream.mock.calls[0][1]).not.toContain("test -f");
    });

    it("installs A, B, A three times and reuses a repeated A", async () => {
      const a = reqs("a");
      const b = reqs("b");
      const { ssh, make } = build(a);
      const sync = make();
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      await sync.installDependencies("vm-1", pyCmd(), b, "/guest/work");
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      expect(ssh.runStream).toHaveBeenCalledTimes(3);
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      expect(ssh.runStream).toHaveBeenCalledTimes(3);
    });

    it("keeps a nonzero-exit B retryable and reinstalls A afterwards", async () => {
      const a = reqs("a");
      const b = reqs("b");
      const { ssh, make } = build(a, [ok, { exitCode: 1, timedOut: false, signal: null, stdout: "boom" }]);
      const sync = make();
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      await expect(sync.installDependencies("vm-1", pyCmd(), b, "/guest/work")).rejects.toThrow(/install failed/i);
      expect(ssh.runStream).toHaveBeenCalledTimes(2);
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work"); // not trusted, not quarantined
      expect(ssh.runStream).toHaveBeenCalledTimes(3);
    });

    const ambiguous: Array<[string, Result | Error]> = [
      ["a timeout", { exitCode: null, timedOut: true, signal: null, stdout: "" }],
      ["a signal", { exitCode: null, timedOut: false, signal: "SIGKILL", stdout: "" }],
      ["a transport throw", new Error("ssh dropped")],
    ];
    for (const [label, outcome] of ambiguous) {
      it(`quarantines the scope after B ends in ${label}`, async () => {
        const a = reqs("a");
        const b = reqs("b");
        const { ssh, make } = build(a, [ok, outcome]);
        const sync = make();
        await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
        await expect(sync.installDependencies("vm-1", pyCmd(), b, "/guest/work")).rejects.toThrow();
        expect(ssh.runStream).toHaveBeenCalledTimes(2);
        // A is invalidated and the scope is quarantined: refused before any RPC,
        // so a possibly still-running installer is never raced.
        await expect(sync.installDependencies("vm-1", pyCmd(), a, "/guest/work")).rejects.toThrow();
        expect(ssh.runStream).toHaveBeenCalledTimes(2);
        // Another VM is a different scope and stays usable.
        await sync.installDependencies("vm-2", pyCmd(), a, "/guest/work");
        expect(ssh.runStream).toHaveBeenCalledTimes(3);
        await sync.installDependencies("vm-2", pyCmd(), a, "/guest/work");
        expect(ssh.runStream).toHaveBeenCalledTimes(3);
      });
    }

    it("isolates the active hash per VM", async () => {
      const a = reqs("a");
      const b = reqs("b");
      const { ssh, make } = build(a);
      const sync = make();
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      await sync.installDependencies("vm-2", pyCmd(), a, "/guest/work"); // other VM installs
      expect(ssh.runStream).toHaveBeenCalledTimes(2);
      await sync.installDependencies("vm-2", pyCmd(), b, "/guest/work"); // B on vm-2 must not evict vm-1
      await sync.installDependencies("vm-1", pyCmd(), a, "/guest/work");
      expect(ssh.runStream).toHaveBeenCalledTimes(3);
    });
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
