// Independent acceptance tests for the existing boat policy at native hooks.
// No implementation diff was read. Real plugin, policy, SSH execution, archive
// commands and filesystems; only the network/VM boundary is local and fake.
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginEnvironmentLease, PluginSyncOperation } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processes = vi.hoisted(() => ({ spawn: vi.fn(), actual: null as typeof spawn | null }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processes.actual = actual.spawn;
  return { ...actual, spawn: processes.spawn };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { LocalSyncSsh, hostileTar, put } from "./test-support/local-sync-ssh.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TIMEOUT = 20_000;
let root: string;
let ssh: LocalSyncSsh;
let lease: PluginEnvironmentLease;
let config: Record<string, unknown>;

beforeEach(async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  root = await mkdtemp(path.join(scratch, "native-sync-policy-"));
  ssh = new LocalSyncSsh(root, processes.actual!);
  processes.spawn.mockReset().mockImplementation(ssh.spawn);
  const clock = { now: () => Date.parse("2026-10-22T18:00:00Z") };
  const boat = new FakeBoat(clock);
  setBoatApiFactoryForTests(() => boat as unknown as BoatApiLike);
  setManagerOverridesForTests({ ssh, now: clock.now, sleep: async () => {} });
  config = { apiKey: "boat_test_only", cliproxyTunnel: false, remoteWorkspaceDir: ssh.remoteRoot };
  await plugin.definition.setup(createFakeContext().ctx as never);
  lease = await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config,
    runId: "sync-policy-fixture", executionWorkspaceId: WORKSPACE,
  });
});

afterEach(async () => {
  await ssh?.cleanup();
  await plugin.definition.onShutdown?.();
  setManagerOverridesForTests({});
  setBoatApiFactoryForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

function requireHook(direction: "in" | "out") {
  const name = direction === "in" ? "onEnvironmentSyncIn" : "onEnvironmentSyncOut";
  const hook = plugin.definition[name];
  // Outside rejects: a missing feature must never satisfy a refusal test.
  expect(hook, `${name} must exist to exercise policy preservation`).toBeTypeOf("function");
  return hook!;
}

function params(operations: PluginSyncOperation[]) {
  return {
    driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config, lease,
    operations: operations.map((operation) => ({
      ...operation,
      files: operation.files.map((file) => ({
        ...file, sourcePath: ssh.remotePath(file.sourcePath), targetPath: ssh.remotePath(file.targetPath),
      })),
    })),
  };
}

function sandbox(...parts: string[]) { return path.join(root, "sandbox", ...parts); }
function host(...parts: string[]) { return path.join(root, "host", ...parts); }
function mapping(sourcePath: string, targetPath: string, kind: "file" | "directory" = "file") {
  return { sourcePath, targetPath, kind };
}

function expectNoInboundPayload(since: number) {
  const sent = ssh.records.slice(since).filter((record) => record.command === "ssh")
    .reduce((bytes, record) => bytes + record.stdinBytes, 0);
  expect(sent, "refuse the entire offending operation before sending any of its payload").toBe(0);
}

describe("native inbound ACP refusal before operation payload", () => {
  // A valid first mapping makes late per-file validation observable: none of
  // this operation may cross SSH when a later mapping/command is refused.
  for (const target of [
    ".paperclip-runtime/cli/process-sessions/run/command.b64",
    "custom-runtime/process-sessions/run/launch.js",
    "process-sessions",
    "custom-runtime/command.b64",
  ]) {
    it(`refuses mapping to ${target} before even an earlier benign file is uploaded`, async () => {
      const hook = requireHook("in");
      await put(host("literal-envelope"), "LITERAL_SENTINEL_NOT_A_CREDENTIAL");
      await put(sandbox("ordinary"), "unchanged");
      const since = ssh.records.length;
      await expect(hook(params([{ operationId: "refuse-mapping", files: [
        mapping(host("literal-envelope"), sandbox("ordinary")),
        mapping(host("literal-envelope"), sandbox(target)),
      ] }]))).rejects.toThrow(/ACP|process.session|command\.b64/i);
      expectNoInboundPayload(since);
      expect(await readFile(sandbox("ordinary"), "utf8")).toBe("unchanged");
      expect(existsSync(sandbox(target))).toBe(false);
    });
  }

  for (const command of [
    "mkdir -p process-sessions/run; printf forbidden > acp-command-ran",
    "cat command.b64; printf forbidden > acp-command-ran",
    "PAPERCLIP_PROCESS_SESSION_COMMAND_B64=LITERAL_SENTINEL_NOT_BASE64 sh -c 'printf forbidden > acp-command-ran'",
    "PAPERCLIP_PROCESS_SESSION_DIR=runtime-session/run sh -c 'printf forbidden > acp-command-ran'",
  ]) {
    it(`refuses post-upload ACP command ${JSON.stringify(command)} before files`, async () => {
      const hook = requireHook("in");
      await put(host("ordinary"), "new payload");
      await put(sandbox("ordinary"), "unchanged");
      const since = ssh.records.length;
      await expect(hook(params([{ operationId: "refuse-command", files: [
        mapping(host("ordinary"), sandbox("ordinary")),
      ], postUploadCommands: [
        { command: "printf forbidden > earlier-command-ran", cwd: ssh.remoteRoot },
        { command, cwd: ssh.remoteRoot },
      ] }]))).rejects.toThrow(/ACP|process.session|command\.b64/i);
      expectNoInboundPayload(since);
      expect(await readFile(sandbox("ordinary"), "utf8")).toBe("unchanged");
      expect(existsSync(sandbox("earlier-command-ran"))).toBe(false);
      expect(existsSync(sandbox("acp-command-ran"))).toBe(false);
    });
  }

  it("refuses an ACP member hidden inside an otherwise ordinary directory upload", async () => {
    const hook = requireHook("in");
    await put(host("tree", "ordinary"), "safe");
    await put(host("tree", "custom-runtime", "process-sessions", "run", "command.b64"), "LITERAL_SENTINEL");
    await put(sandbox("ordinary"), "unchanged");
    const since = ssh.records.length;
    await expect(hook(params([{ operationId: "refuse-member", files: [
      mapping(host("tree", "ordinary"), sandbox("ordinary")),
      mapping(host("tree"), sandbox("tree"), "directory"),
    ] }]))).rejects.toThrow(/ACP|process.session|command\.b64/i);
    expectNoInboundPayload(since);
    expect(await readFile(sandbox("ordinary"), "utf8")).toBe("unchanged");
    expect(existsSync(sandbox("tree"))).toBe(false);
  });

  it("keeps near-match names transferable rather than broadening refusal to arbitrary substrings", async () => {
    const hook = requireHook("in");
    await put(host("normal"), "safe");
    const target = sandbox("process-sessions-archive", "notcommand.b64x");
    expect(await hook(params([{ operationId: "not-acp", files: [mapping(host("normal"), target)] }]))).toEqual({
      operations: [{ operationId: "not-acp", filesTransferred: 1, bytesTransferred: 4 }],
    });
    expect(await readFile(target, "utf8")).toBe("safe");
  });
});

describe("native post-upload execution keeps existing shell policy", () => {
  it("keeps GNU tar runtime exclusion, removes VM tokens, and passes the command byte-for-byte", async () => {
    const hook = requireHook("in");
    const cwd = sandbox("command-cwd");
    await put(path.join(cwd, ".paperclip-runtime", "vm-owned"), "vm-owned");
    await put(host("bundle.tar"), hostileTar([
      { name: "ordinary", body: "safe" },
      { name: ".paperclip-runtime/vm-owned", body: "CORRUPT" },
      { name: ".paperclip-runtime/host-only", body: "LITERAL_HOST_RUNTIME_SENTINEL" },
      { name: "nested/.paperclip-runtime/host-only", body: "LITERAL_NESTED_RUNTIME_SENTINEL" },
    ]));
    ssh.remoteEnv = { ASCII_TOKEN: "LITERAL_ASCII_SENTINEL", BOAT_ID: "LITERAL_BOAT_SENTINEL" };
    const command = "# preserve leading comment\ntar -xf bundle.tar\nprintf '%s|%s' \"${ASCII_TOKEN-unset}\" \"${BOAT_ID-unset}\" > credential-state\ncat /proc/$$/cmdline > shell-argv\n# preserve trailing comment";
    const request = params([{ operationId: "tar-policy", files: [
      mapping(host("bundle.tar"), path.join(cwd, "bundle.tar")),
    ], postUploadCommands: [{ command, cwd: ssh.remotePath(cwd), timeoutMs: 5000 }] }]);
    const original = structuredClone(request);
    await hook(request);
    expect(await readFile(path.join(cwd, "ordinary"), "utf8")).toBe("safe");
    expect(await readFile(path.join(cwd, "credential-state"), "utf8")).toBe("unset|unset");
    expect((await readFile(path.join(cwd, "shell-argv"), "utf8")).split("\0")).toContain(command);
    expect(request).toEqual(original);
    expect(await readFile(path.join(cwd, ".paperclip-runtime", "vm-owned"), "utf8")).toBe("vm-owned");
    expect(existsSync(path.join(cwd, ".paperclip-runtime", "host-only"))).toBe(false);
    expect(existsSync(path.join(cwd, "nested", ".paperclip-runtime", "host-only"))).toBe(false);
  }, TIMEOUT);

  it("refuses even a cwd symlink that stays inside the workspace", async () => {
    const hook = requireHook("in");
    await put(sandbox("real", "nested", "sentinel"), "unchanged");
    await symlink(sandbox("real"), sandbox("pivot"));
    await expect(hook(params([{ operationId: "no-symlink-cwd", files: [], postUploadCommands: [
      { command: "printf CORRUPT > sentinel", cwd: `${ssh.remoteRoot}/pivot/nested` },
    ] }]))).rejects.toThrow();
    expect(await readFile(sandbox("real", "nested", "sentinel"), "utf8")).toBe("unchanged");
    expect(await readlink(sandbox("pivot"))).toBe(sandbox("real"));
  });
});

for (const direction of ["in", "out"] as const) {
  describe(`native ${direction} runtime-directory send policy`, () => {
    function locations() {
      return direction === "in"
        ? { source: host("source"), target: sandbox("target") }
        : { source: sandbox("source"), target: host("target") };
    }

    it("omits nested runtime members, counts only sent files, and still destroys stale ordinary members", async () => {
      const hook = requireHook(direction);
      const { source, target } = locations();
      await put(path.join(source, "ordinary"), "safe");
      await put(path.join(source, "nested", "ordinary"), "ok");
      await put(path.join(source, ".paperclip-runtime", "launch.json"), "LITERAL_RUNTIME_SENTINEL");
      await put(path.join(source, "nested", ".paperclip-runtime", "config.json"), "LITERAL_NESTED_SENTINEL");
      await put(path.join(source, ".paperclip-runtime-backup", "keep"), "keep");
      await put(path.join(target, "stale"), "remove-me");
      expect(await hook(params([{ operationId: "runtime-omission", files: [mapping(source, target, "directory")] }]))).toEqual({
        operations: [{ operationId: "runtime-omission", filesTransferred: 3, bytesTransferred: 10 }],
      });
      expect(await readFile(path.join(target, "ordinary"), "utf8")).toBe("safe");
      expect(await readFile(path.join(target, "nested", "ordinary"), "utf8")).toBe("ok");
      expect(await readFile(path.join(target, ".paperclip-runtime-backup", "keep"), "utf8")).toBe("keep");
      expect(existsSync(path.join(target, ".paperclip-runtime", "launch.json"))).toBe(false);
      expect(existsSync(path.join(target, "nested", ".paperclip-runtime", "config.json"))).toBe(false);
      expect(existsSync(path.join(target, "stale"))).toBe(false);
    });

    it("allows an explicit runtime asset directory root while omitting its own nested runtime children", async () => {
      const hook = requireHook(direction);
      const { source, target: workspace } = locations();
      const target = path.join(workspace, ".paperclip-runtime", "cli", "assets");
      const assets = path.join(source, ".paperclip-runtime", "cli", "assets");
      await put(path.join(assets, "mcp.json"), "asset", 0o600);
      await put(path.join(assets, "nested", "helper.js"), "helper");
      await put(path.join(assets, ".paperclip-runtime", "do-not-copy"), "LITERAL_RUNTIME_SENTINEL");
      expect(await hook(params([{ operationId: "explicit-assets", files: [mapping(assets, target, "directory")] }]))).toEqual({
        operations: [{ operationId: "explicit-assets", filesTransferred: 2, bytesTransferred: 11 }],
      });
      expect(await readFile(path.join(target, "mcp.json"), "utf8")).toBe("asset");
      expect((await lstat(path.join(target, "mcp.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(target, "nested", "helper.js"), "utf8")).toBe("helper");
      expect(existsSync(path.join(target, ".paperclip-runtime", "do-not-copy"))).toBe(false);
    });

    it("allows an explicit single runtime asset mapping", async () => {
      const hook = requireHook(direction);
      const { source, target: workspace } = locations();
      const target = path.join(workspace, ".paperclip-runtime", "cli", "mcp.json");
      const asset = path.join(source, ".paperclip-runtime", "cli", "mcp.json");
      await put(asset, "asset", 0o600);
      expect(await hook(params([{ operationId: "explicit-file", files: [mapping(asset, target)] }]))).toEqual({
        operations: [{ operationId: "explicit-file", filesTransferred: 1, bytesTransferred: 5 }],
      });
      expect(await readFile(target, "utf8")).toBe("asset");
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
    });
  });
}

describe("native inbound workspace replacement preserves snapshot safety", () => {
  for (const runtime of ["absent", "directory", "symlink"] as const) {
    it(`replaces the workspace without importing a host runtime ${runtime} or losing the real 0700 directory`, async () => {
      const hook = requireHook("in");
      await put(host("workspace", "ordinary"), "fresh");
      await put(sandbox("stale"), "remove-me");
      const outside = host("outside-runtime");
      await put(path.join(outside, "sentinel"), "unchanged");
      if (runtime === "symlink") {
        await symlink(outside, host("workspace", ".paperclip-runtime"));
      } else if (runtime === "directory") {
        await put(host("workspace", ".paperclip-runtime", "host-only"), "LITERAL_HOST_RUNTIME_SENTINEL");
      }
      // Keep existing home snapshot exclusions, not just the new runtime rule.
      await put(path.join(root, ".boatignore"), "node_modules/\n.paperclip-runtime/\ncustom-cache/\n");
      const ignoreBefore = await readFile(path.join(root, ".boatignore"), "utf8");
      expect(await hook(params([{ operationId: "replace-workspace", files: [
        mapping(host("workspace"), sandbox(), "directory"),
      ] }]))).toEqual({ operations: [{ operationId: "replace-workspace", filesTransferred: 1, bytesTransferred: 5 }] });
      expect(await readFile(sandbox("ordinary"), "utf8")).toBe("fresh");
      expect(existsSync(sandbox("stale"))).toBe(false);
      expect(existsSync(sandbox(".paperclip-runtime")), "workspace replacement must recreate the VM runtime directory").toBe(true);
      const stat = await lstat(sandbox(".paperclip-runtime"));
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(existsSync(sandbox(".paperclip-runtime", "host-only"))).toBe(false);
      expect(existsSync(sandbox(".paperclip-runtime", "sentinel"))).toBe(false);
      expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
      expect(await readFile(path.join(root, ".boatignore"), "utf8")).toBe(ignoreBefore);
    });
  }
});

describe("local VM credential sentinel control", () => {
  it("returns remote control paths in the VM namespace instead of leaking scratch into lease metadata", async () => {
    const session = [...ssh.sessionMap.values()][0]!;
    const result = await ssh.run(session, `printf '%s' '${ssh.remoteRoot}'`, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/home/user/native-sync-fixture");
    expect(lease.metadata?.remoteCwd).toBe("/home/user/native-sync-fixture");
  });

  it("really supplies literal VM credentials so an absent unset cannot pass the native command test", async () => {
    ssh.remoteEnv = { ASCII_TOKEN: "LITERAL_ASCII_SENTINEL", BOAT_ID: "LITERAL_BOAT_SENTINEL" };
    const session = [...ssh.sessionMap.values()][0]!;
    const result = await ssh.run(session, "printf '%s|%s' \"$ASCII_TOKEN\" \"$BOAT_ID\"", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("LITERAL_ASCII_SENTINEL|LITERAL_BOAT_SENTINEL");
  });
});
