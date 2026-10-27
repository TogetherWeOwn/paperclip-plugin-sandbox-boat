import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshOffloadSync } from "./offload-ssh-sync.js";
import {
  hashManifest,
  MIRROR_MARKER_RELPATH,
  MIRROR_PRUNE_SCRIPT,
  MIRROR_VERIFY_SCRIPT,
  MIRROR_WIPE_SCRIPT,
  MIRROR_WRITE_SCRIPT,
  SshGuestStore,
  type MirrorMarker,
} from "./offload-ssh-guest-store.js";
import { captureSnapshot, SyncError } from "./offload-sync.js";
import type { OffloadCommand } from "./offload.js";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}
function source(files: Record<string, string>): string {
  const dir = temp("boat-delta-src-");
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WS_A = "c0000000-0000-4000-8000-00000000000a";
const WS_B = "c0000000-0000-4000-8000-00000000000b";
let commandCounter = 0;
function command(over: Partial<OffloadCommand> = {}): OffloadCommand {
  commandCounter += 1;
  return {
    commandId: `7d82278c-2ba7-4e68-96ab-a2cc10b69${String(commandCounter).padStart(3, "0")}`.slice(0, 36),
    companyId: COMPANY,
    runId: RUN,
    cardId: "card",
    repoId: "repo:https://github.com/example/app",
    profileId: "rust-public-1",
    tool: "cargo",
    runner: "cargo",
    argv: ["test", "--locked"],
    executionWorkspaceId: WS_A,
    cwdRelative: ".",
    env: {},
    ...over,
  };
}

async function readAll(stream: Readable | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Programmable stub guest: per-VM markers, suspect parents and one-shot failures. */
interface StubGuest {
  markers: Map<string, MirrorMarker>;
  suspect: Map<string, string>;
  failNext: { verify?: unknown; prune?: unknown; write?: unknown } | null;
  wipes: Array<{ vm: string; dir: string }>;
  prunes: Array<{ vm: string; dir: string; paths: string[] }>;
  installs: string[];
}
function stubGuest(): StubGuest {
  return { markers: new Map(), suspect: new Map(), failNext: null, wipes: [], prunes: [], installs: [] };
}
const guestKey = (vm: string, dir: string) => `${vm}\0${dir}`;
function setMarker(guest: StubGuest, vm: string, dir: string, marker: MirrorMarker): void {
  guest.markers.set(guestKey(vm, dir), marker);
}
function getMarker(guest: StubGuest, vm: string, dir: string): MirrorMarker | undefined {
  return guest.markers.get(guestKey(vm, dir));
}

interface SpawnCall { command: string; args: string[]; stdin: string }
interface Setup {
  sync: SshOffloadSync;
  ssh: { runStream: ReturnType<typeof vi.fn>; ensureKey: () => Promise<{ privateKeyPath: string; publicKey: string }> };
  spawn: ReturnType<typeof vi.fn>;
  spawns: SpawnCall[];
  guest: StubGuest;
  refreshSession: ReturnType<typeof vi.fn>;
  sessionFor: (sandboxId: string) => unknown;
}

function setup(root: string, guest: StubGuest = stubGuest()): Setup {
  const spawns: SpawnCall[] = [];
  const spawn = vi.fn(async (cmd: string, args: string[], opts: { stdin: Readable; timeoutMs: number }) => {
    spawns.push({ command: cmd, args, stdin: await readAll(opts.stdin) });
    return { exitCode: 0, signal: null, timedOut: false };
  });
  const sessionFor = (sandboxId: string) => ({
    sandboxId,
    endpoint: { host: "10.0.0.9", port: 2222, user: "user", hostKey: "ssh-ed25519 AAAATEST" },
    knownHostsPath: "/test/known_hosts",
    controlPath: `/test/${sandboxId}.ctl`,
    master: null,
    tunnel: "disabled",
    tunnelSpec: null,
    tunnelError: null,
    connectTimeoutSec: 10,
    lastMasterStartAt: 0,
  });
  const refreshSession = vi.fn(async (sandboxId: string) => sessionFor(sandboxId) as never);
  const runStream = vi.fn(async (session: unknown, remoteCommand: string, opts: { stdin?: Readable } = {}) => {
    const vm = (session as { sandboxId?: string })?.sandboxId ?? "vm-?";
    const stdin = await readAll(opts.stdin);
    const ok = (stdout: unknown) => ({ exitCode: 0, timedOut: false, signal: null, stdout: JSON.stringify(stdout), stderr: "" });
    if (remoteCommand.includes("boat-offload-mirror-verify")) {
      if (guest.failNext?.verify) {
        const error = guest.failNext.verify;
        guest.failNext = null;
        throw error;
      }
      const [mirrorDir] = JSON.parse(stdin) as [string, unknown];
      const marker = guest.markers.get(guestKey(vm, mirrorDir)) ?? null;
      return ok({ marker, suspect: guest.suspect.get(guestKey(vm, mirrorDir)) ?? null });
    }
    if (remoteCommand.includes("boat-offload-mirror-write")) {
      if (guest.failNext?.write) {
        const error = guest.failNext.write;
        guest.failNext = null;
        throw error;
      }
      const [mirrorDir, marker] = JSON.parse(stdin) as [string, MirrorMarker];
      guest.markers.set(guestKey(vm, mirrorDir), marker);
      return ok({ ok: true });
    }
    if (remoteCommand.includes("boat-offload-mirror-wipe")) {
      const [mirrorDir] = JSON.parse(stdin) as [string];
      guest.wipes.push({ vm, dir: mirrorDir });
      guest.markers.delete(guestKey(vm, mirrorDir));
      guest.suspect.delete(guestKey(vm, mirrorDir));
      return ok({ ok: true });
    }
    if (remoteCommand.includes("boat-offload-mirror-prune")) {
      if (guest.failNext?.prune) {
        const error = guest.failNext.prune;
        guest.failNext = null;
        throw error;
      }
      const [mirrorDir, paths] = JSON.parse(stdin) as [string, string[]];
      guest.prunes.push({ vm, dir: mirrorDir, paths });
      return ok({ removed: paths.length });
    }
    if (remoteCommand.includes("boat-offload-inspect")) {
      // collect(): scan returns a clean tree; bounded reads return nothing.
      if (stdin.includes('"scan"')) return ok({});
      return ok(null);
    }
    if (remoteCommand.includes("test -f")) return { exitCode: 1, timedOut: false, signal: null, stdout: "", stderr: "" };
    if (remoteCommand.includes("shutil.rmtree")) throw new Error("test stub: guest checkout deletion is not expected on stage");
    guest.installs.push(remoteCommand);
    return { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" };
  });
  const ssh = { runStream, ensureKey: async () => ({ privateKeyPath: "/test/id_ed25519", publicKey: "test" }) };
  const sync = new SshOffloadSync({
    ssh: ssh as never,
    session: async (sandboxId: string) => sessionFor(sandboxId) as never,
    refreshSession: refreshSession as never,
    sourceRoot: async () => root,
    artifactRoot: temp("boat-delta-artifacts-"),
    workRoot: "/tmp/boat-test",
    spawn: spawn as never,
  });
  return { sync, ssh, spawn, spawns, guest, refreshSession, sessionFor };
}

function filesFromStdin(stdin: string): string[] {
  if (stdin === "") return [];
  return stdin.split("\0").filter((entry) => entry !== "");
}

describe("per-card mirror directory", () => {
  it("is shared by commands of one card and isolated between cards", () => {
    const { sync } = setup(source({ "a.txt": "a" }));
    const first = command({ executionWorkspaceId: WS_A });
    const second = command({ executionWorkspaceId: WS_A });
    expect(first.commandId).not.toBe(second.commandId);
    expect(sync.directory(first)).toBe(sync.directory(second));
    expect(sync.directory(first)).toMatch(/^\/tmp\/boat-test\/paperclip-boat-mirror-[0-9a-f]{32}$/);
    expect(sync.directory(command({ executionWorkspaceId: WS_B }))).not.toBe(sync.directory(first));
  });

  it("falls back to per-command isolation without an execution workspace", () => {
    const { sync } = setup(source({ "a.txt": "a" }));
    const first = command({ executionWorkspaceId: undefined });
    const second = command({ executionWorkspaceId: undefined });
    expect(sync.directory(first)).not.toBe(sync.directory(second));
  });
});

describe("delta push over stub SSH", () => {
  it("uploads every file on the first push, then zero files for an unchanged tree", async () => {
    const root = source({ "a.txt": "a", "sub/b.txt": "b" });
    const { sync, spawns, ssh } = setup(root);
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(1);
    expect(filesFromStdin(spawns[0]!.stdin).sort()).toEqual(["a.txt", "sub/b.txt"]);
    const runsAfterFirst = ssh.runStream.mock.calls.length;
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(1); // unchanged tree: rsync never spawns
    const secondPushRuns = ssh.runStream.mock.calls.slice(runsAfterFirst).map((call) => String(call[1]));
    expect(secondPushRuns.some((cmd) => cmd.includes("boat-offload-mirror-verify"))).toBe(true);
    expect(secondPushRuns.some((cmd) => cmd.includes("boat-offload-mirror-prune"))).toBe(false);
    expect(secondPushRuns.some((cmd) => cmd.includes("boat-offload-mirror-write"))).toBe(false);
  });

  it("uploads exactly one file for one edit", async () => {
    const root = source({ "a.txt": "a", "sub/b.txt": "b" });
    const { sync, spawns } = setup(root);
    await sync.push("vm-1", command());
    writeFileSync(path.join(root, "sub/b.txt"), "b-changed");
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(2);
    expect(filesFromStdin(spawns[1]!.stdin)).toEqual(["sub/b.txt"]);
  });

  it("resyncs a mode-only change without missing it", async () => {
    const root = source({ "run.sh": "echo hi" });
    const { sync, spawns } = setup(root);
    await sync.push("vm-1", command());
    chmodSync(path.join(root, "run.sh"), 0o755);
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(2);
    expect(filesFromStdin(spawns[1]!.stdin)).toEqual(["run.sh"]);
  });

  it("preserves times and modes over the pinned control master and never deletes", async () => {
    const root = source({ "a.txt": "a" });
    const { sync, spawns } = setup(root);
    await sync.push("vm-1", command());
    expect(spawns[0]!.command).toBe("rsync");
    const args = spawns[0]!.args;
    for (const flag of ["-a", "--times", "--perms", "--checksum", "--files-from=-", "--from0"]) {
      expect(args).toContain(flag);
    }
    expect(args.some((arg) => arg === "--delete" || arg.startsWith("--delete="))).toBe(false);
    const sshArg = args[args.indexOf("-e") + 1]!;
    expect(sshArg).toContain("ControlPath=/test/vm-1.ctl");
    expect(sshArg).toContain("UserKnownHostsFile=/test/known_hosts");
    expect(sshArg).toContain("HostKeyAlias=vm-1");
    expect(args[args.length - 1]).toBe(`user@10.0.0.9:${sync.directory(command())}`);
  });

  it("prunes a removed input from the mirror without uploading", async () => {
    const root = source({ "a.txt": "a", "gone.txt": "gone" });
    const { sync, spawns, guest } = setup(root);
    await sync.push("vm-1", command());
    rmSync(path.join(root, "gone.txt"));
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(1); // nothing to send
    expect(guest.prunes).toHaveLength(1);
    expect(guest.prunes[0]!.paths).toEqual(["gone.txt"]);
    expect(guest.prunes[0]!.dir).toBe(sync.directory(command()));
  });

  it("falls back to a full upload on a new machine with no marker", async () => {
    const root = source({ "a.txt": "a", "sub/b.txt": "b" });
    const { sync, spawns } = setup(root);
    await sync.push("vm-1", command());
    await sync.push("vm-2", command());
    expect(spawns).toHaveLength(2);
    expect(filesFromStdin(spawns[1]!.stdin).sort()).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("falls back to a full upload when the guest marker disagrees with host state", async () => {
    const root = source({ "a.txt": "a" });
    const { sync, spawns, guest } = setup(root);
    await sync.push("vm-1", command());
    const dir = sync.directory(command());
    setMarker(guest, "vm-1", dir, { version: 1, mirrorKey: "forged", manifestHash: "0".repeat(64) });
    await sync.push("vm-1", command());
    expect(spawns).toHaveLength(2);
    expect(filesFromStdin(spawns[1]!.stdin)).toEqual(["a.txt"]);
  });

  it("wipes and fully resyncs a mirror with a symlinked parent, never writing through it", async () => {
    const root = source({ "a.txt": "a" });
    const { sync, spawns, guest } = setup(root);
    await sync.push("vm-1", command());
    const dir = sync.directory(command());
    guest.suspect.set(guestKey("vm-1", dir), "sub");
    await sync.push("vm-1", command());
    expect(guest.wipes).toEqual([{ vm: "vm-1", dir }]);
    expect(spawns).toHaveLength(2);
    expect(filesFromStdin(spawns[1]!.stdin)).toEqual(["a.txt"]);
  });

  it("isolates concurrent cards pushing on the same VM", async () => {
    const rootA = source({ "a.txt": "a" });
    const rootB = source({ "b.txt": "b" });
    const guest = stubGuest();
    const harness = setup(rootA, guest);
    const syncB = new SshOffloadSync({
      ssh: harness.ssh as never,
      session: async (sandboxId: string) => harness.sessionFor(sandboxId) as never,
      refreshSession: harness.refreshSession as never,
      sourceRoot: async (cmd: OffloadCommand) => (cmd.executionWorkspaceId === WS_B ? rootB : rootA),
      artifactRoot: temp("boat-delta-artifacts-b-"),
      workRoot: "/tmp/boat-test",
      spawn: harness.spawn as never,
    });
    const dirA = harness.sync.directory(command({ executionWorkspaceId: WS_A }));
    const dirB = harness.sync.directory(command({ executionWorkspaceId: WS_B }));
    expect(dirA).not.toBe(dirB);
    await harness.sync.push("vm-1", command({ executionWorkspaceId: WS_A }));
    await syncB.push("vm-1", command({ executionWorkspaceId: WS_B }));
    expect(filesFromStdin(harness.spawns[0]!.stdin)).toEqual(["a.txt"]);
    expect(filesFromStdin(harness.spawns[1]!.stdin)).toEqual(["b.txt"]);
    expect(getMarker(guest, "vm-1", dirA)).toBeDefined();
    expect(getMarker(guest, "vm-1", dirB)).toBeDefined();
    expect(getMarker(guest, "vm-1", dirA)).not.toEqual(getMarker(guest, "vm-1", dirB));
    // Card A is still clean after card B pushed between its commands.
    await harness.sync.push("vm-1", command({ executionWorkspaceId: WS_A }));
    expect(harness.spawns).toHaveLength(2);
  });

  it("refreshes a stale session once and retries the push", async () => {
    const root = source({ "a.txt": "a" });
    const { sync, spawns, guest, refreshSession } = setup(root);
    guest.failNext = { verify: new Error("mux_client_request_session: session request failed") };
    await sync.push("vm-1", command());
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledWith("vm-1");
    expect(spawns).toHaveLength(1);
  });

  it("surfaces the push failure when no session refresh is available", async () => {
    const root = source({ "a.txt": "a" });
    const guest = stubGuest();
    guest.failNext = { verify: new Error("mux_client_request_session: session request failed") };
    const harness = setup(root, guest);
    const sync = new SshOffloadSync({
      ssh: harness.ssh as never,
      session: async (sandboxId: string) => harness.sessionFor(sandboxId) as never,
      sourceRoot: async () => root,
      artifactRoot: temp("boat-delta-artifacts-c-"),
      workRoot: "/tmp/boat-test",
      spawn: harness.spawn as never,
    });
    await expect(sync.push("vm-1", command())).rejects.toThrow(/session request failed/);
    expect(harness.refreshSession).not.toHaveBeenCalled();
  });

  it("installs checkout-local dependencies once per mirror, again after a lockfile change", async () => {
    const root = source({ "package.json": JSON.stringify({ name: "app" }), "package-lock.json": "{}" });
    const node = (over: Partial<OffloadCommand> = {}) =>
      command({ tool: "node", runner: "npm", profileId: "node-public-1", argv: ["run", "test"], ...over });
    const { sync, ssh } = setup(root);
    const installs = () => ssh.runStream.mock.calls.filter((call) => String(call[1]).includes("npm")).length;
    await sync.push("vm-1", node());
    expect(installs()).toBe(1);
    await sync.push("vm-1", node());
    expect(installs()).toBe(1); // mirror marker hit: no reinstall on a warm mirror
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ version: 2 }));
    await sync.push("vm-1", node());
    expect(installs()).toBe(2); // new lockfile hash reinstalls
  });

  it("collects and stages without deleting the persistent mirror", async () => {
    const root = source({});
    const { sync, ssh } = setup(root);
    const cmd = command();
    await sync.push("vm-1", cmd);
    const collected = await sync.collect("vm-1", cmd);
    const runsBeforeStage = ssh.runStream.mock.calls.length;
    const staged = await sync.stage("vm-1", cmd, collected);
    expect(ssh.runStream.mock.calls.length).toBe(runsBeforeStage);
    expect(staged).toMatchObject({ state: "clean", changedPaths: [] });
  });

  it("keeps the guest cwd inside the per-card mirror", async () => {
    const { sync } = setup(source({ "a.txt": "a" }));
    const cmd = command({ cwdRelative: "sub/dir" });
    expect(await sync.cwd("vm-1", cmd)).toBe(`${sync.directory(cmd)}/sub/dir`);
    await expect(sync.cwd("vm-1", command({ cwdRelative: "../escape" }))).rejects.toThrow(/escapes/);
  });
});

describe("SshGuestStore boundary", () => {
  function store(guest: StubGuest = stubGuest()) {
    const harness = setup(source({ "a.txt": "a" }), guest);
    const guestStore = new SshGuestStore({ ssh: harness.ssh as never, session: harness.sessionFor("vm-1") as never, spawn: harness.spawn as never });
    return { ...harness, guestStore };
  }

  it("pushes nothing without spawning when the plan is empty", async () => {
    const { guestStore, spawns } = store();
    const result = await guestStore.push("/snapshot", [], "/guest/mirror");
    expect(result).toEqual({ files: 0, bytes: 0, skipped: 0 });
    expect(spawns).toHaveLength(0);
  });

  it("refuses traversal deletes client-side, before any transport call", async () => {
    const { guestStore, ssh } = store();
    for (const rel of ["../escape", "/absolute", ""]) {
      const error = await guestStore.pruneMirror("/guest/mirror", [rel]).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe("SYNC_TRAVERSAL");
    }
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("skips the prune round trip when nothing was removed", async () => {
    const { guestStore, ssh } = store();
    await expect(guestStore.pruneMirror("/guest/mirror", [])).resolves.toEqual({ removed: 0 });
    expect(ssh.runStream).not.toHaveBeenCalled();
  });

  it("fails closed when rsync reports an error", async () => {
    const harness = setup(source({ "a.txt": "a" }));
    harness.spawn.mockResolvedValueOnce({ exitCode: 255, signal: null, timedOut: false });
    const guestStore = new SshGuestStore({ ssh: harness.ssh as never, session: harness.sessionFor("vm-1") as never, spawn: harness.spawn as never });
    const snap = await captureSnapshot(source({ "a.txt": "a" }), temp("boat-delta-snap-"));
    await expect(guestStore.push(temp("boat-delta-empty-"), snap.manifest.files, "/guest/mirror")).rejects.toThrow(/delta push failed/i);
  });
});

describe("hashManifest", () => {
  it("is stable for an unchanged tree and moves on content, mode or mtime edits", async () => {
    const root = source({ "a.txt": "a" });
    const first = (await captureSnapshot(root, temp("boat-delta-h1-"))).manifest;
    const second = (await captureSnapshot(root, temp("boat-delta-h2-"))).manifest;
    expect(hashManifest(first)).toBe(hashManifest(second));
    writeFileSync(path.join(root, "a.txt"), "b");
    const edited = (await captureSnapshot(root, temp("boat-delta-h3-"))).manifest;
    expect(hashManifest(edited)).not.toBe(hashManifest(first));
    writeFileSync(path.join(root, "a.txt"), "a");
    chmodSync(path.join(root, "a.txt"), 0o755);
    const chmodded = (await captureSnapshot(root, temp("boat-delta-h4-"))).manifest;
    expect(hashManifest(chmodded)).not.toBe(hashManifest(first));
  });
});

describe("mirror scripts executed locally", () => {
  function runScript(script: string, stdin: unknown, cwd = temp("boat-delta-script-")): { stdout: string; exitCode: number | null } {
    try {
      const stdout = execFileSync("python3", ["-I", "-c", script], { input: JSON.stringify(stdin), encoding: "utf8", cwd, stdio: ["pipe", "pipe", "pipe"] });
      return { stdout, exitCode: 0 };
    } catch (error) {
      return { stdout: String((error as { stdout?: unknown })?.stdout ?? ""), exitCode: (error as { status?: number }).status ?? null };
    }
  }

  it("verify creates a missing mirror and reports no marker", () => {
    const mirror = path.join(temp("boat-delta-mirror-"), "mirror");
    const { stdout, exitCode } = runScript(MIRROR_VERIFY_SCRIPT, [mirror, []]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ marker: null, suspect: null });
  });

  it("verify returns a stored marker and ignores a corrupt one", () => {
    const mirror = temp("boat-delta-mirror-");
    mkdirSync(path.join(mirror, ".boat-offload"), { recursive: true });
    const marker: MirrorMarker = { version: 1, mirrorKey: "key", manifestHash: "ab".repeat(32) };
    writeFileSync(path.join(mirror, MIRROR_MARKER_RELPATH), JSON.stringify(marker));
    const hit = runScript(MIRROR_VERIFY_SCRIPT, [mirror, ["a.txt"]]);
    expect(hit.exitCode).toBe(0);
    expect(JSON.parse(hit.stdout)).toEqual({ marker, suspect: null });
    writeFileSync(path.join(mirror, MIRROR_MARKER_RELPATH), "{not json");
    const corrupt = runScript(MIRROR_VERIFY_SCRIPT, [mirror, []]);
    expect(corrupt.exitCode).toBe(0);
    expect(JSON.parse(corrupt.stdout)).toEqual({ marker: null, suspect: null });
  });

  it("verify refuses a symlinked mirror or an escaping planned path", () => {
    const dir = temp("boat-delta-mirror-");
    const target = path.join(dir, "real");
    mkdirSync(target);
    const linked = path.join(dir, "linked");
    symlinkSync(target, linked);
    expect(runScript(MIRROR_VERIFY_SCRIPT, [linked, []]).exitCode).not.toBe(0);
    expect(runScript(MIRROR_VERIFY_SCRIPT, [target, ["../escape"]]).exitCode).not.toBe(0);
  });

  it("verify flags a symlinked parent, a file-as-parent and a directory leaf", () => {
    const mirror = temp("boat-delta-mirror-");
    mkdirSync(path.join(mirror, "real"));
    symlinkSync("real", path.join(mirror, "linked"));
    writeFileSync(path.join(mirror, "afile"), "x");
    mkdirSync(path.join(mirror, "adir"));
    const linked = runScript(MIRROR_VERIFY_SCRIPT, [mirror, ["linked/nested.txt"]]);
    expect(linked.exitCode).toBe(0);
    expect(JSON.parse(linked.stdout).suspect).toBe("linked/nested.txt");
    const fileParent = runScript(MIRROR_VERIFY_SCRIPT, [mirror, ["afile/nested.txt"]]);
    expect(JSON.parse(fileParent.stdout).suspect).toBe("afile/nested.txt");
    const dirLeaf = runScript(MIRROR_VERIFY_SCRIPT, [mirror, ["adir"]]);
    expect(JSON.parse(dirLeaf.stdout).suspect).toBe("adir");
    const clean = runScript(MIRROR_VERIFY_SCRIPT, [mirror, ["real/nested.txt", "new.txt"]]);
    expect(JSON.parse(clean.stdout)).toEqual({ marker: null, suspect: null });
  });

  it("prune removes only files and links inside the mirror", () => {
    const mirror = temp("boat-delta-mirror-");
    mkdirSync(path.join(mirror, "sub"), { recursive: true });
    writeFileSync(path.join(mirror, "top-gone.txt"), "x");
    writeFileSync(path.join(mirror, "sub", "gone.txt"), "x");
    symlinkSync("gone.txt", path.join(mirror, "sub", "link"));
    mkdirSync(path.join(mirror, "keepdir"));
    const { stdout, exitCode } = runScript(MIRROR_PRUNE_SCRIPT,
      [mirror, ["top-gone.txt", "missing-first.txt", "sub/gone.txt", "sub/link", "missing.txt", "keepdir"]]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ removed: 3 });
    expect(lstatSync(path.join(mirror, "keepdir")).isDirectory()).toBe(true);
    expect(runScript(MIRROR_PRUNE_SCRIPT, [mirror, ["../escape"]]).exitCode).not.toBe(0);
  });

  it("write stores the marker atomically", () => {
    const mirror = temp("boat-delta-mirror-");
    const marker: MirrorMarker = { version: 1, mirrorKey: "key", manifestHash: "cd".repeat(32) };
    const { exitCode } = runScript(MIRROR_WRITE_SCRIPT, [mirror, marker]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(path.join(mirror, MIRROR_MARKER_RELPATH), "utf8"))).toEqual(marker);
  });

  it("wipe removes a hostile mirror and recreates an empty dir", () => {
    const dir = temp("boat-delta-mirror-");
    const mirror = path.join(dir, "mirror");
    mkdirSync(path.join(mirror, "sub"), { recursive: true });
    symlinkSync("/etc", path.join(mirror, "evil"));
    writeFileSync(path.join(mirror, "sub", "file.txt"), "x");
    const { exitCode } = runScript(MIRROR_WIPE_SCRIPT, [mirror]);
    expect(exitCode).toBe(0);
    expect(lstatSync(mirror).isDirectory()).toBe(true);
    expect(() => lstatSync(path.join(mirror, "evil"))).toThrow();
    expect(() => lstatSync(path.join(mirror, "sub"))).toThrow();
    const linked = path.join(dir, "linked");
    symlinkSync(mirror, linked);
    expect(runScript(MIRROR_WIPE_SCRIPT, [linked]).exitCode).not.toBe(0);
  });
});
