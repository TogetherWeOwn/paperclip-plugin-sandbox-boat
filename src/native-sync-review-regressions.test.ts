// Independent acceptance cases for reviewed head 08ceb0a8. No implementation diff read.
// Real helper processes and binary relay; this is NOT multiplexed SSH evidence.
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
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
import { syncFiles } from "./file-sync.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import type { StreamProcessOptions } from "./ssh.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { LocalSyncSsh, put } from "./test-support/local-sync-ssh.js";
import { gnuExtensionArchive } from "./test-support/native-sync-review-fixtures.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
let root: string;
let ssh: LocalSyncSsh;
let lease: PluginEnvironmentLease;
let config: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "sync-regressions-"));
  ssh = new LocalSyncSsh(root, processes.actual!);
  processes.spawn.mockReset().mockImplementation(ssh.spawn);
  const clock = { now: () => Date.parse("2026-10-23T00:00:00Z") };
  setBoatApiFactoryForTests(() => new FakeBoat(clock) as unknown as BoatApiLike);
  setManagerOverridesForTests({ ssh, now: clock.now, sleep: async () => {} });
  config = { apiKey: "boat_test_only", cliproxyTunnel: false, remoteWorkspaceDir: ssh.remoteRoot };
  await plugin.definition.setup(createFakeContext().ctx as never);
  lease = await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config,
    runId: "review-regressions", executionWorkspaceId: WORKSPACE,
  });
  await mkdir(path.join(root, "sandbox"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ssh?.cleanup();
  await plugin.definition.onShutdown?.();
  setManagerOverridesForTests({});
  setBoatApiFactoryForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

function sandbox(name: string) { return path.join(root, "sandbox", name); }
function host(name: string) { return path.join(root, "host", name); }
function mapping(sourcePath: string, targetPath: string, kind: "file" | "directory" = "file") {
  return { sourcePath, targetPath, kind };
}
function request(operations: PluginSyncOperation[]) {
  return { driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config, lease,
    operations: operations.map((operation) => ({ ...operation, files: operation.files.map((file) => ({
      ...file, sourcePath: ssh.remotePath(file.sourcePath), targetPath: ssh.remotePath(file.targetPath),
    })) })),
  };
}
function hook(direction: "in" | "out") {
  const fn = plugin.definition[direction === "in" ? "onEnvironmentSyncIn" : "onEnvironmentSyncOut"];
  expect(fn).toBeTypeOf("function");
  return fn!;
}

describe("explicit post-upload deadline replaces, rather than clamps to, provider default", () => {
  // Direct syncFiles seam avoids the provider's 30-second minimum configuration.
  // runStream remains real; the spy observes only the resolved dispatch deadline.
  for (const { label, override, want, delay, success } of [
    { label: "longer override", override: 3000, want: 3000, delay: 1.6, success: true },
    { label: "missing override fallback", override: undefined, want: 1000, delay: 0.02, success: true },
    { label: "smaller override success", override: 600, want: 600, delay: 0.02, success: true },
    { label: "smaller override timeout", override: 600, want: 600, delay: 1.6, success: false },
    { label: "missing override timeout", override: undefined, want: 1000, delay: 1.6, success: false },
  ]) {
    it(label, async () => {
      const session = ssh.getSession(lease.providerLeaseId!)!;
      const dispatch = vi.spyOn(ssh, "runStream");
      const operation: PluginSyncOperation = { operationId: "deadline", files: [], postUploadCommands: [
        { command: `printf started > started; sleep ${delay}; printf complete > complete`, timeoutMs: override },
        { command: "printf forbidden > later-command" },
      ] };
      const pending = syncFiles({ ssh, session, remoteRoot: ssh.remoteRoot, timeoutMs: 1000 }, "in", [operation,
        { operationId: "later", files: [], postUploadCommands: [{ command: "printf forbidden > later-operation" }] },
      ]);
      const outcome = await pending.then((result) => ({ result, error: null }), (error: Error) => ({ result: null, error }));
      expect.soft(dispatch.mock.calls[0][2].timeoutMs, "exact resolved timeout dispatched to real transport").toBe(want);
      if (success) {
        expect.soft(outcome.error, "command finishing within explicit timeout must succeed").toBeNull();
        expect(outcome.result).toEqual({ operations: [
          { operationId: "deadline", filesTransferred: 0, bytesTransferred: 0 },
          { operationId: "later", filesTransferred: 0, bytesTransferred: 0 },
        ] });
        expect(await readFile(sandbox("complete"), "utf8")).toBe("complete");
      } else {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error!.message).toMatch(/timedOut=true/);
        expect(await readFile(sandbox("started"), "utf8")).toBe("started");
        expect(existsSync(sandbox("complete"))).toBe(false);
        expect(existsSync(sandbox("later-command"))).toBe(false);
        expect(existsSync(sandbox("later-operation"))).toBe(false);
        expect(dispatch).toHaveBeenCalledTimes(1);
      }
      expect(dispatch.mock.calls[0][2].timeoutMs).toBe(want);
    });
  }
});

describe("outbound command refusal is before payload, even for commands-only operations", () => {
  // Removing only syncFiles' outbound guard must turn each refusal into success.
  for (const withFiles of [false, true]) {
    it(`rejects nonempty commands with files=${withFiles}`, async () => {
      const sync = hook("out");
      await put(sandbox("source"), "payload");
      const since = ssh.records.length;
      await expect(sync(request([
        { operationId: "forbidden", files: withFiles ? [mapping(sandbox("source"), host("first"))] : [],
          postUploadCommands: [{ command: "printf forbidden > command-ran" }] },
        { operationId: "later", files: [mapping(sandbox("source"), host("later"))] },
      ]))).rejects.toThrow(/only.*inbound|inbound.*only/i);
      expect(ssh.records.slice(since)).toEqual([]);
      expect(existsSync(sandbox("command-ran"))).toBe(false);
      expect(existsSync(host("first"))).toBe(false);
      expect(existsSync(host("later"))).toBe(false);
    });
  }
  for (const commands of [undefined, []]) {
    it(`accepts ${commands === undefined ? "absent" : "empty"} outbound commands and exact accounting`, async () => {
      const sync = hook("out");
      await put(sandbox("source"), "abc");
      expect(await sync(request([
        { operationId: "empty", files: [], postUploadCommands: commands },
        { operationId: "file", files: [mapping(sandbox("source"), host("target"))], postUploadCommands: commands },
      ]))).toEqual({ operations: [
        { operationId: "empty", filesTransferred: 0, bytesTransferred: 0 },
        { operationId: "file", filesTransferred: 1, bytesTransferred: 3 },
      ] });
      expect(await readFile(host("target"), "utf8")).toBe("abc");
    });
  }
});

describe("receiver accounting is untrusted control JSON at the real inbound transfer seam", () => {
  const valid = { filesTransferred: 1, bytesTransferred: 3 };
  const malformed: { label: string; json: string }[] = [];
  for (const field of ["filesTransferred", "bytesTransferred"] as const) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    malformed.push({ label: `${field} missing`, json: JSON.stringify(missing) });
    for (const [label, value] of [["string", "1"], ["negative", -1], ["unsafe integer", 9007199254740992]] as const) {
      malformed.push({ label: `${field} ${label}`, json: JSON.stringify({ ...valid, [field]: value }) });
    }
  }
  malformed.push({ label: "malformed JSON", json: "{broken" }, { label: "null JSON", json: "null" });
  for (const { label, json } of malformed) {
    it(`rejects ${label} before commands or later operations`, async () => {
      const sync = hook("in");
      await put(host("source"), "abc");
      const real = ssh.runStream.bind(ssh);
      let injections = 0;
      vi.spyOn(ssh, "runStream").mockImplementation(async (session, command, options: StreamProcessOptions) => {
        const result = await real(session, command, options);
        if (options.stdin) { injections++; return { ...result, stdout: json }; }
        return result;
      });
      await expect(sync(request([
        { operationId: "bad-counts", files: [mapping(host("source"), sandbox("first"))],
          postUploadCommands: [{ command: "printf forbidden > command-ran" }] },
        { operationId: "later", files: [mapping(host("source"), sandbox("later"))] },
      ]))).rejects.toThrow();
      expect(injections).toBe(1);
      expect(await readFile(sandbox("first"), "utf8"), "payload really crossed before control corruption").toBe("abc");
      expect(existsSync(sandbox("command-ran"))).toBe(false);
      expect(existsSync(sandbox("later"))).toBe(false);
    });
  }
  it("retains exact valid zero/nonzero receiver controls", async () => {
    const sync = hook("in");
    await put(host("source"), "abc");
    await mkdir(host("empty"), { recursive: true });
    expect(await sync(request([
      { operationId: "zero", files: [mapping(host("empty"), sandbox("empty"), "directory")] },
      { operationId: "nonzero", files: [mapping(host("source"), sandbox("file"))] },
    ]))).toEqual({ operations: [
      { operationId: "zero", filesTransferred: 0, bytesTransferred: 0 },
      { operationId: "nonzero", filesTransferred: 1, bytesTransferred: 3 },
    ] });
  });
});

describe("GNU metadata cap is payload size, not decoded NAME_MAX", () => {
  for (const type of ["L", "K"] as const) {
    for (const size of [262143, 262144, 262145]) {
      it(`${type === "L" ? "longname" : "longlink"} ${size} bytes through hook`, async () => {
        const sync = hook("out");
        await put(sandbox("source/short"), "abc");
        const archive = path.join(root, "extension.tar");
        await put(archive, gnuExtensionArchive(type, size));
        ssh.archiveOverride = archive;
        const real = ssh.runStream.bind(ssh);
        vi.spyOn(ssh, "runStream").mockImplementation(async (session, command, options) => ({
          ...await real(session, command, options), stderr: "ARBITRARY_REMOTE_STDERR_CANARY",
        }));
        const pending = sync(request([
          { operationId: "metadata", files: [mapping(sandbox("source"), host("target"), "directory")] },
          { operationId: "later", files: [mapping(sandbox("source"), host("later"), "directory")] },
        ]));
        if (size > 262144) {
          const error = await pending.then(() => null, (reason: Error) => reason);
          expect(error, "oversize metadata must fail loudly").toBeInstanceOf(Error);
          expect(error!.message).not.toContain("tar extension exceeds metadata limit");
          expect(error!.message).not.toContain("Traceback");
          expect(error!.message).not.toContain("ARBITRARY_REMOTE_STDERR_CANARY");
          expect(existsSync(host("later"))).toBe(false);
        } else {
          expect(await pending).toEqual({ operations: [
            { operationId: "metadata", filesTransferred: type === "L" ? 1 : 0, bytesTransferred: type === "L" ? 3 : 0 },
            { operationId: "later", filesTransferred: type === "L" ? 1 : 0, bytesTransferred: type === "L" ? 3 : 0 },
          ] });
          if (type === "L") expect(await readFile(host("target/short"), "utf8")).toBe("abc");
          else expect(await readlink(host("target/short"))).toBe("short-target");
        }
        expect(existsSync(ssh.archiveInjected)).toBe(true);
      });
    }
  }
});
