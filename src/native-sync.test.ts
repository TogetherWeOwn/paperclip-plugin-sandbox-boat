// Acceptance tests authored against the public hook contract, not an
// implementation diff. Baseline: 0c73b94 + f1993e4. Contract document blob:
// TogetherWeOwn/paperclip 951bf02009022b3a2e8911c8f2a4f58ac49dc00c.
//
// Transfer code and SshManager.run/runStream stay real. Only connection setup
// and the SSH network hop are replaced by a local binary relay subprocess.
// Proposed streaming seam is documented in test-support/local-sync-ssh.ts.
import type { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
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
import manifest from "./manifest.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { LocalSyncSsh, digest, hostileTar, populatedFiles, put, waitFor } from "./test-support/local-sync-ssh.js";
import type { StreamingSsh } from "./test-support/local-sync-ssh.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TIMEOUT = 20_000;
const CHUNK_CAP = 256 * 1024;
// Incompressible fixture: gates must still engage if a provider compresses tar.
const syntheticBytes = randomBytes(2 * 1024 * 1024);
let root: string;
let ssh: LocalSyncSsh;
let lease: PluginEnvironmentLease;
let config: Record<string, unknown>;

beforeEach(async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  root = await mkdtemp(path.join(scratch, "native-sync-"));
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
    runId: "sync-fixture", executionWorkspaceId: WORKSPACE,
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
  expect(hook, `${name} must be defined before native sync is advertised`).toBeTypeOf("function");
  return hook!;
}

function requireStreaming(): StreamingSsh {
  const transport = ssh as unknown as StreamingSsh;
  expect(transport.runStream, "SshManager needs a binary, backpressured runStream transport").toBeTypeOf("function");
  return transport;
}

function params(operations: PluginSyncOperation[]) {
  // The provider sees valid VM paths; filesystem setup/assertions use scratch.
  // Only mapping paths are translated here, never opaque command strings.
  const remoteOperations = operations.map((operation) => ({
    ...operation,
    files: operation.files.map((file) => ({
      ...file, sourcePath: ssh.remotePath(file.sourcePath), targetPath: ssh.remotePath(file.targetPath),
    })),
  }));
  return { driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config, lease, operations: remoteOperations };
}

async function mode(file: string) { return (await lstat(file)).mode & 0o777; }

async function atGate(transfer: Promise<unknown>) {
  let finished = false;
  let failure: unknown;
  void transfer.then(() => { finished = true; }, (error) => { failure = error; finished = true; });
  await waitFor(() => {
    if (failure) throw failure;
    if (existsSync(ssh.gate!.reached)) return true;
    if (finished) throw new Error("transfer finished before the partial-write gate was reached");
    return false;
  }, "real transfer never reached the partial-write gate");
}

async function largeFile(file: string, bytes: number) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "w", 0o644);
  try {
    const chunkSize = 64 * 1024;
    for (let written = 0; written < bytes; written += chunkSize) {
      await handle.write(randomBytes(Math.min(chunkSize, bytes - written)));
    }
  } finally { await handle.close(); }
}

describe("native sync opt-in", () => {
  it("defines both hooks; a half-opt-in silently leaves the host on the fallback", () => {
    requireHook("in");
    requireHook("out");
  });

  it("declares both native transport capabilities on the boat environment driver", () => {
    const driver = manifest.environmentDrivers?.find((entry) => entry.driverKey === "boat");
    expect(driver?.sandboxCapabilities).toMatchObject({ nativeSyncIn: true, nativeSyncOut: true });
    // The pinned SDK rejects unsupported top-level extras; validate the actual
    // manifest, not a test-created driver that could hide an invalid opt-in.
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.environmentDrivers?.find((entry) => entry.driverKey === "boat")?.sandboxCapabilities)
      .toMatchObject({ nativeSyncIn: true, nativeSyncOut: true });
  });

  it("advertises both verbs through the real SDK initialize handshake", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin: input, stdout: output, rpcTimeoutMs: 1000 });
    let pending = "";
    const response = new Promise<{ result?: { ok: boolean; supportedMethods: string[] }; error?: unknown }>((resolve) => {
      output.on("data", (chunk) => {
        pending += String(chunk);
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          // Worker->host calls (setup subscriptions) share the id space: only a reply without a method answers initialize.
          if (message.id === 1 && !message.method) resolve(message);
          // Answer any setup host call, without asserting on the stand-in.
          else if (message.id != null && message.method) input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null })}\n`);
        }
      });
    });
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: COMPANY, hostVersion: "2026.1012.0" },
      } })}\n`);
      const reply = await response;
      expect(reply.error).toBeUndefined();
      expect(reply.result?.ok).toBe(true);
      expect(reply.result?.supportedMethods).toEqual(expect.arrayContaining(["environmentSyncIn", "environmentSyncOut"]));
    } finally { host.stop(); input.destroy(); output.destroy(); }
  }, TIMEOUT);
});

for (const direction of ["in", "out"] as const) {
  describe(`native sync ${direction}: observable filesystem contract`, () => {
    function locations() {
      return direction === "in"
        ? { source: path.join(root, "host", "source"), target: path.join(root, "sandbox", "target") }
        : { source: path.join(root, "sandbox", "source"), target: path.join(root, "host", "target") };
    }

    // Deliberately not async: the missing-hook assertion must throw outside
    // expect(...).rejects, or negative tests could pass on the absent feature.
    function sync(operations: PluginSyncOperation[]) { return requireHook(direction)(params(operations)); }
    function mapping(sourcePath: string, targetPath: string, kind: "file" | "directory" = "file") {
      return { sourcePath, targetPath, kind };
    }

    it("returns an empty ordered result for no operations", async () => {
      expect(await sync([])).toEqual({ operations: [] });
    });

    it("applies operations in order, echoes arbitrary/duplicate opaque ids, and counts per operation", async () => {
      const { source, target } = locations();
      await put(path.join(source, "first"), "first");
      await put(path.join(source, "second"), Buffer.from([0, 255, 128]));
      const opaque = "not/a/phase:../ ' \" ; $()\n";
      const operations: PluginSyncOperation[] = [
        { operationId: opaque, files: [mapping(path.join(source, "first"), target)] },
        { operationId: "duplicate", files: [mapping(path.join(source, "second"), target)] },
        { operationId: "duplicate", files: [] },
      ];
      const original = structuredClone(operations);
      const request = params(operations);
      const originalRequest = structuredClone(request);
      expect(await requireHook(direction)(request)).toEqual({ operations: [
        { operationId: opaque, filesTransferred: 1, bytesTransferred: 5 },
        { operationId: "duplicate", filesTransferred: 1, bytesTransferred: 3 },
        { operationId: "duplicate", filesTransferred: 0, bytesTransferred: 0 },
      ] });
      expect(await readFile(target)).toEqual(Buffer.from([0, 255, 128]));
      expect(operations).toEqual(original);
      expect(request).toEqual(originalRequest);
      expect(existsSync(path.join(root, "not"))).toBe(false);
    });

    it("does not start a later operation while an earlier payload is still streaming", async () => {
      const { source, target } = locations();
      await put(path.join(source, "first"), syntheticBytes);
      await put(path.join(source, "second"), "later");
      ssh.armGate(direction);
      const transfer = sync([
        { operationId: "first", files: [mapping(path.join(source, "first"), path.join(target, "first"))] },
        { operationId: "second", files: [mapping(path.join(source, "second"), path.join(target, "second"))] },
      ]);
      void transfer.catch(() => {});
      try {
        await atGate(transfer);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(existsSync(path.join(target, "second")), "operations must not run concurrently").toBe(false);
      } finally { await ssh.releaseGate(); }
      expect(await transfer).toEqual({ operations: [
        { operationId: "first", filesTransferred: 1, bytesTransferred: syntheticBytes.length },
        { operationId: "second", filesTransferred: 1, bytesTransferred: 5 },
      ] });
      expect(await readFile(path.join(target, "second"), "utf8")).toBe("later");
    }, TIMEOUT);

    it("counts actual regular-file bytes in a directory and multiple mappings, not tar padding or directories", async () => {
      const { source, target } = locations();
      await put(path.join(source, "tree", "a"), "abc");
      await put(path.join(source, "tree", "nested", "b"), Buffer.from([0, 255]));
      await put(path.join(source, "tree", "empty"), "");
      await mkdir(path.join(source, "tree", "empty-dir"));
      await put(path.join(source, "single"), "1234");
      expect(await sync([{ operationId: "counts", files: [
        mapping(path.join(source, "tree"), path.join(target, "tree"), "directory"),
        mapping(path.join(source, "single"), path.join(target, "single")),
      ] }])).toEqual({ operations: [{ operationId: "counts", filesTransferred: 4, bytesTransferred: 9 }] });
      expect(await readFile(path.join(target, "tree", "nested", "b"))).toEqual(Buffer.from([0, 255]));
      expect((await lstat(path.join(target, "tree", "empty-dir"))).isDirectory()).toBe(true);
    });

    it("transfers binary bytes and shell-metacharacter paths literally", async () => {
      const { source, target } = locations();
      const filename = "literal '$(touch pwned)' ; & `touch pwned-too` \n ü.bin";
      const src = path.join(source, filename);
      const dst = path.join(target, filename);
      const bytes = Buffer.from([...Array.from({ length: 256 }, (_, value) => value), 0, 255]);
      await put(src, bytes);
      expect(await sync([{ operationId: "literal", files: [mapping(src, dst)] }])).toEqual({
        operations: [{ operationId: "literal", filesTransferred: 1, bytesTransferred: 258 }],
      });
      expect(await readFile(dst)).toEqual(bytes);
      expect(existsSync(path.join(root, "pwned"))).toBe(false);
      expect(existsSync(path.join(root, "pwned-too"))).toBe(false);
    });

    it("quotes metacharacter directory paths used by native archivers", async () => {
      const { source, target } = locations();
      const name = "folder '$(touch directory-pwned)' ; \n ü";
      const src = path.join(source, name);
      const dst = path.join(target, name);
      await put(path.join(src, "bytes"), "literal directory");
      await sync([{ operationId: "directory-path", files: [mapping(src, dst, "directory")] }]);
      expect(await readFile(path.join(dst, "bytes"), "utf8")).toBe("literal directory");
      expect(existsSync(path.join(root, "directory-pwned"))).toBe(false);
    });

    it("preserves restrictive and executable source modes inside a directory when no override is requested", async () => {
      const { source, target } = locations();
      await put(path.join(source, "private"), "private bytes", 0o600);
      await put(path.join(source, "executable"), "executable bytes", 0o760);
      // Explicitly set source mode: the harness deliberately uses umask 022,
      // so writeFile's creation mode alone would mask out group-write.
      const executable = await open(path.join(source, "executable"));
      try { await executable.chmod(0o760); } finally { await executable.close(); }
      await sync([{ operationId: "source-modes", files: [mapping(source, target, "directory")] }]);
      expect(await mode(path.join(target, "private"))).toBe(0o600);
      expect(await mode(path.join(target, "executable"))).toBe(0o760);
    });

    for (const followSymlinks of [undefined, false, true]) {
      it(`${followSymlinks ? "dereferences" : "preserves"} file and directory symlinks with followSymlinks=${String(followSymlinks)}`, async () => {
        const { source, target } = locations();
        await put(path.join(source, "real", "bytes"), "content");
        await symlink("real/bytes", path.join(source, "file-link"));
        await symlink("real", path.join(source, "dir-link"));
        const files = [{ ...mapping(source, target, "directory"), followSymlinks }];
        await sync([{ operationId: "links", files }]);
        if (followSymlinks) {
          expect((await lstat(path.join(target, "file-link"))).isSymbolicLink()).toBe(false);
          expect((await lstat(path.join(target, "dir-link"))).isDirectory()).toBe(true);
          expect(await readFile(path.join(target, "file-link"), "utf8")).toBe("content");
          expect(await readFile(path.join(target, "dir-link", "bytes"), "utf8")).toBe("content");
        } else {
          expect((await lstat(path.join(target, "file-link"))).isSymbolicLink()).toBe(true);
          expect(await readlink(path.join(target, "file-link"))).toBe("real/bytes");
          expect(await readlink(path.join(target, "dir-link"))).toBe("real");
          expect(await readFile(path.join(target, "real", "bytes"), "utf8")).toBe("content");
        }
      });
    }

    it("applies directory exclude globs to contents and per-operation accounting", async () => {
      const { source, target } = locations();
      await put(path.join(source, "keep.txt"), "yes");
      await put(path.join(source, "nested", "keep.txt"), "also");
      await put(path.join(source, "nested", "drop.tmp"), "exclude me");
      await put(path.join(source, "cache", "nested", "blob"), "exclude me too");
      expect(await sync([{ operationId: "exclude", files: [{
        ...mapping(source, target, "directory"), exclude: ["**/*.tmp", "cache/**"],
      }] }])).toEqual({ operations: [{ operationId: "exclude", filesTransferred: 2, bytesTransferred: 7 }] });
      expect(await readFile(path.join(target, "nested", "keep.txt"), "utf8")).toBe("also");
      expect(existsSync(path.join(target, "nested", "drop.tmp"))).toBe(false);
      expect(existsSync(path.join(target, "cache", "nested", "blob"))).toBe(false);
      expect(existsSync(path.join(source, "nested", "drop.tmp"))).toBe(true);
    });

    it("destroys the previous directory tree instead of overlaying new files", async () => {
      const { source, target } = locations();
      await put(path.join(source, "new"), "new tree");
      await put(path.join(target, "old", "stale"), "must disappear");
      await sync([{ operationId: "replace", files: [mapping(source, target, "directory")] }]);
      expect(await readFile(path.join(target, "new"), "utf8")).toBe("new tree");
      expect(existsSync(path.join(target, "old"))).toBe(false);
      expect(await readFile(path.join(source, "new"), "utf8")).toBe("new tree");
    });

    for (const kind of ["file", "directory"] as const) {
      it(`rejects a missing ${kind} source instead of reporting zero/partial success`, async () => {
        const { source, target } = locations();
        await expect(sync([{ operationId: "missing", files: [mapping(source, target, kind)] }])).rejects.toThrow();
        // A directory failure may leave a partial/empty tree: the contract
        // deliberately promises no directory rollback or transactionality.
        if (kind === "file") expect(existsSync(target)).toBe(false);
      });
    }

    it("fails fast on an operation error without executing later operations", async () => {
      const { source, target } = locations();
      await put(path.join(source, "valid"), "must not land");
      await expect(sync([
        { operationId: "bad", files: [mapping(path.join(source, "missing"), path.join(target, "bad"))] },
        { operationId: "later", files: [mapping(path.join(source, "valid"), path.join(target, "later"))] },
      ])).rejects.toThrow();
      expect(existsSync(path.join(target, "later"))).toBe(false);
    });

    it("raises a nonzero remote subprocess result, even if some bytes already moved", async () => {
      const { source, target } = locations();
      await put(source, "bytes");
      ssh.exitCode = 23;
      await expect(sync([{ operationId: "nonzero", files: [mapping(source, target)] }])).rejects.toThrow();
    });

    it("raises a failed local tar subprocess if the native transfer uses one", async () => {
      const hook = requireHook(direction);
      const { source, target } = locations();
      await put(path.join(source, "bytes"), "payload");
      ssh.failLocalTar = true;
      let rejected = false;
      try {
        await hook(params([{ operationId: "archiver-error", files: [mapping(source, target, "directory")] }]));
      } catch { rejected = true; }
      if (ssh.records.some((entry) => entry.command === "tar")) {
        expect(rejected, "nonzero local producer/extractor must not report success").toBe(true);
      } else {
        expect(rejected).toBe(false);
        expect(await readFile(path.join(target, "bytes"), "utf8")).toBe("payload");
      }
    });

    it("raises a transport spawn failure rather than returning success", async () => {
      const { source, target } = locations();
      await put(source, "bytes");
      ssh.spawnError = true;
      await expect(sync([{ operationId: "transport", files: [mapping(source, target)] }])).rejects.toThrow();
    });

    it("never truncates the old single-file target when a real transfer is interrupted", async () => {
      const { source, target } = locations();
      await put(source, syntheticBytes);
      await put(target, "complete old contents", 0o600);
      const gate = ssh.armGate(direction, true);
      const transfer = sync([{ operationId: "interrupted", files: [mapping(source, target)] }]);
      void transfer.catch(() => {});
      try {
        await atGate(transfer);
        expect(await readFile(target, "utf8")).toBe("complete old contents");
      } finally { await ssh.releaseGate(); }
      await expect(transfer).rejects.toThrow();
      expect(existsSync(gate.reached), "fault must interrupt payload bytes, not setup").toBe(true);
      expect(await readFile(target, "utf8")).toBe("complete old contents");
      expect(await mode(target)).toBe(0o600);
    });

    it("stages a single-file replacement in the same directory without colliding with reserved scratch or a real target", async () => {
      const { source, target } = locations();
      await put(source, syntheticBytes);
      await put(target, "old");
      const oldInode = (await lstat(target)).ino;
      const reserved = `${target}.paperclip-upload`;
      const realSibling = `${target}.paperclip-upload.keep`;
      await put(reserved, "fallback scratch belongs to someone else");
      await put(realSibling, "real sibling");
      ssh.armGate(direction);
      const transfer = sync([{ operationId: "atomic", files: [mapping(source, target)] }]);
      void transfer.catch(() => {});
      try {
        await atGate(transfer);
        let scratch: string[] = [];
        await waitFor(async () => {
          scratch = (await populatedFiles(path.dirname(target))).filter((file) => ![target, reserved, realSibling].includes(file));
          return scratch.length > 0;
        }, "no populated same-directory staging file while transfer is paused");
        expect(scratch.every((file) => path.dirname(file) === path.dirname(target))).toBe(true);
        expect(await readFile(target, "utf8")).toBe("old");
        expect(await readFile(reserved, "utf8")).toBe("fallback scratch belongs to someone else");
      } finally { await ssh.releaseGate(); }
      await transfer;
      expect(await readFile(target)).toEqual(syntheticBytes);
      expect((await lstat(target)).ino, "rename must replace, not overwrite the old inode").not.toBe(oldInode);
      expect(await readFile(reserved, "utf8")).toBe("fallback scratch belongs to someone else");
      expect(await readFile(realSibling, "utf8")).toBe("real sibling");
    }, TIMEOUT);

    for (const kind of ["file", "directory"] as const) {
      it(`applies 0600 before bytes become visible for a ${kind} mapping, not a post-transfer chmod`, async () => {
        const { source, target } = locations();
        const src = kind === "file" ? source : path.join(source, "nested", "credential");
        const dst = kind === "file" ? target : path.join(target, "nested", "credential");
        await put(src, syntheticBytes, 0o644); // mapping, not source mode, must enforce 0600
        if (kind === "directory") await put(path.join(source, "another"), "private", 0o644);
        await mkdir(path.dirname(target), { recursive: true });
        ssh.armGate(direction);
        const transfer = sync([{ operationId: "mode", files: [{ ...mapping(source, target, kind), mode: 0o600 }] }]);
        void transfer.catch(() => {});
        try {
          await atGate(transfer);
          let partial: string[] = [];
          await waitFor(async () => {
            partial = await populatedFiles(path.dirname(target));
            const sizes = await Promise.all(partial.map(async (file) => (await lstat(file)).size));
            return sizes.some((size) => size >= 16 * 1024 && size < syntheticBytes.length);
          }, "no partially written target/scratch file while mode transfer is paused");
          for (const file of partial) expect(await mode(file), `visible bytes at ${file}`).toBe(0o600);
        } finally { await ssh.releaseGate(); }
        await transfer;
        expect(await mode(dst)).toBe(0o600);
        expect(await readFile(dst)).toEqual(syntheticBytes);
        if (kind === "directory") expect(await mode(path.join(target, "another"))).toBe(0o600);
      }, TIMEOUT);
    }

    it("streams a multi-megabyte binary file without passing payloads through buffered control exec", async () => {
      const { source, target } = locations();
      const size = 24 * 1024 * 1024 + 17;
      await largeFile(source, size);
      const result = await sync([{ operationId: "large", files: [mapping(source, target)] }]);
      expect(result).toEqual({ operations: [{ operationId: "large", filesTransferred: 1, bytesTransferred: size }] });
      expect(await digest(target)).toBe(await digest(source));
      expect(Math.max(0, ...ssh.bufferedPayloads), "run() is control-only; large bytes need runStream()").toBeLessThanOrEqual(CHUNK_CAP);
      const payload = ssh.records.filter((entry) => entry.command === "ssh");
      const transferred = payload.reduce((sum, entry) => sum + Math.max(entry.stdinBytes, entry.stdoutBytes), 0);
      expect(transferred, "large file must cross the real transport, in a stream or bounded chunks").toBeGreaterThanOrEqual(size);
      expect(Math.max(...payload.map((entry) => entry.maxInputChunk))).toBeLessThanOrEqual(CHUNK_CAP);
    }, TIMEOUT);
  });
}

describe("installed SDK postUploadCommands contract", () => {
  // Each assertion catches silently ignored commands, command/file reordering,
  // ambient cwd, shell-fragment rewriting, or swallowed command failures.
  function sync(operations: PluginSyncOperation[]) { return requireHook("in")(params(operations)); }
  function sandbox(...parts: string[]) { return path.join(root, "sandbox", ...parts); }

  it("runs commands after all files, in array/operation order, with an explicit confined cwd", async () => {
    const cwd = sandbox("command cwd ' ; $(touch cwd-pwned)");
    await mkdir(cwd, { recursive: true });
    await put(path.join(root, "host", "a"), "first");
    await put(path.join(root, "host", "b"), "second");
    const result = await sync([
      { operationId: "upload-and-command", files: [
        { sourcePath: path.join(root, "host", "a"), targetPath: path.join(cwd, "a"), kind: "file" },
        { sourcePath: path.join(root, "host", "b"), targetPath: path.join(cwd, "b"), kind: "file" },
      ], postUploadCommands: [
        { command: "cat a b > ordered", cwd: ssh.remotePath(cwd) },
        { command: "printf ':command-two' >> ordered", cwd: ssh.remotePath(cwd) },
      ] },
      { operationId: "commands-only", files: [], postUploadCommands: [
        { command: "printf ':next-operation' >> ordered", cwd: ssh.remotePath(cwd) },
      ] },
    ]);
    expect(await readFile(path.join(cwd, "ordered"), "utf8")).toBe("firstsecond:command-two:next-operation");
    expect(result).toEqual({ operations: [
      { operationId: "upload-and-command", filesTransferred: 2, bytesTransferred: 11 },
      { operationId: "commands-only", filesTransferred: 0, bytesTransferred: 0 },
    ] });
    expect(existsSync(path.join(root, "cwd-pwned"))).toBe(false);
    expect(existsSync(sandbox("cwd-pwned"))).toBe(false);
  });

  it("defaults absent cwd to the configured remote root, never the relay/process cwd", async () => {
    await mkdir(sandbox(), { recursive: true });
    await sync([{ operationId: "default-cwd", files: [], postUploadCommands: [
      { command: "printf default-root > default-command-result" },
    ] }]);
    expect(await readFile(sandbox("default-command-result"), "utf8")).toBe("default-root");
    expect(existsSync(path.join(root, "default-command-result"))).toBe(false);
  });

  it("executes the opaque command as an unchanged shell argument, not provider-concatenated fragments", async () => {
    const cwd = sandbox("opaque");
    await mkdir(cwd, { recursive: true });
    const command = "# leading comment must survive\nprintf '%s' 'literal ; && $(not-executed) `nor-this`' > literal\ncat /proc/$$/cmdline > shell-argv\n# trailing comment";
    const request = params([{ operationId: "opaque", files: [], postUploadCommands: [
      { command, cwd: ssh.remotePath(cwd), timeoutMs: 5000 },
    ] }]);
    const original = structuredClone(request);
    await requireHook("in")(request);
    expect(await readFile(path.join(cwd, "literal"), "utf8")).toBe("literal ; && $(not-executed) `nor-this`");
    // Linux exposes the actual shell argv. Cwd/env wrappers are fine only if
    // they pass this command as its own byte-identical -c argument.
    const argv = (await readFile(path.join(cwd, "shell-argv"), "utf8")).split("\0");
    expect(argv).toContain(command);
    expect(request).toEqual(original);
  });

  for (const failure of ["nonzero", "timeout"] as const) {
    it(`fails fast on command ${failure}, without later commands or operations`, async () => {
      const hook = requireHook("in");
      const cwd = sandbox("fail-fast");
      await mkdir(cwd, { recursive: true });
      const source = path.join(root, "host", "source");
      await put(source, "uploaded first");
      const started = Date.now();
      await expect(hook(params([
        { operationId: "command-error", files: [
          { sourcePath: source, targetPath: path.join(cwd, "uploaded"), kind: "file" },
        ], postUploadCommands: [
          { command: `cat uploaded > command-started; ${failure === "nonzero" ? "exit 29" : "exec sleep 30"}`,
            cwd: ssh.remotePath(cwd), timeoutMs: failure === "timeout" ? 1000 : 5000 },
          { command: "printf forbidden > later-command", cwd: ssh.remotePath(cwd) },
        ] },
        { operationId: "later-operation", files: [
          { sourcePath: source, targetPath: path.join(cwd, "later-file"), kind: "file" },
        ], postUploadCommands: [
          { command: "printf forbidden > later-operation", cwd: ssh.remotePath(cwd) },
        ] },
      ]))).rejects.toThrow();
      expect(await readFile(path.join(cwd, "command-started"), "utf8")).toBe("uploaded first");
      expect(Date.now() - started).toBeLessThan(8000);
      for (const file of ["later-command", "later-file", "later-operation"]) {
        expect(existsSync(path.join(cwd, file))).toBe(false);
      }
    }, TIMEOUT);
  }

  it("never runs commands if this operation's file upload failed", async () => {
    const hook = requireHook("in");
    const cwd = sandbox("upload-failure");
    await mkdir(cwd, { recursive: true });
    await expect(hook(params([{ operationId: "missing-file", files: [
      { sourcePath: path.join(root, "host", "missing"), targetPath: path.join(cwd, "target"), kind: "file" },
    ], postUploadCommands: [{ command: "printf forbidden > must-not-run", cwd: ssh.remotePath(cwd) }] }]))).rejects.toThrow();
    expect(existsSync(path.join(cwd, "must-not-run"))).toBe(false);
  });

  for (const cwd of ["relative", "/", "/home/user/other-workspace", "/home/user/native-sync-fixture/../other-workspace", "$HOME", "~/workspace"]) {
    it(`rejects unconfined command cwd ${JSON.stringify(cwd)} before executing it`, async () => {
      const hook = requireHook("in");
      const sentinel = path.join(root, "cwd-refusal-sentinel");
      await put(sentinel, "unchanged");
      await expect(hook(params([{ operationId: "bad-cwd", files: [], postUploadCommands: [
        { command: `printf CORRUPT > '${sentinel}'`, cwd },
      ] }]))).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    });
  }

  it("rejects a lexically confined cwd whose symlink ancestor escapes the remote root", async () => {
    const hook = requireHook("in");
    const outside = path.join(root, "outside-command-root");
    await put(path.join(outside, "nested", "sentinel"), "unchanged");
    await mkdir(sandbox(), { recursive: true });
    await symlink(outside, sandbox("cwd-pivot"));
    await expect(hook(params([{ operationId: "symlink-cwd", files: [], postUploadCommands: [
      { command: "printf CORRUPT > sentinel", cwd: `${ssh.remoteRoot}/cwd-pivot/nested` },
    ] }]))).rejects.toThrow();
    expect(await readFile(path.join(outside, "nested", "sentinel"), "utf8")).toBe("unchanged");
  });
});

describe("host target confinement", () => {
  for (const kind of ["file", "directory"] as const) {
    it(`refuses a ${kind} target under an existing host symlink ancestor`, async () => {
      const hook = requireHook("out");
      const source = path.join(root, "sandbox", "source");
      const outside = path.join(root, "outside-host-target");
      const sentinel = path.join(outside, "nested", "sentinel");
      await put(sentinel, "unchanged");
      await put(kind === "file" ? source : path.join(source, "sentinel"), "CORRUPT");
      await mkdir(path.join(root, "host"), { recursive: true });
      await symlink(outside, path.join(root, "host", "pivot"));
      const target = path.join(root, "host", "pivot", "nested", ...(kind === "file" ? ["sentinel"] : []));
      await expect(hook(params([{ operationId: "host-ancestor", files: [
        { sourcePath: source, targetPath: target, kind },
      ] }]))).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      expect(await readlink(path.join(root, "host", "pivot"))).toBe(outside);
    });
  }
});

describe("outbound untrusted archive boundary (when using tar)", () => {
  for (const attack of ["parent traversal", "absolute path", "symlink parent escape", "symlink absolute escape", "hardlink parent escape", "symlink chain escape"] as const) {
    it(`rejects ${attack} without touching anything outside the mapped target`, async () => {
      const hook = requireHook("out");
      const source = path.join(root, "sandbox", "source");
      const target = path.join(root, "host", "target");
      const sentinel = path.join(root, "host", "outside-sentinel");
      await put(path.join(source, "safe"), "safe");
      await put(sentinel, "unchanged");
      await mkdir(target, { recursive: true });
      const entries = attack === "parent traversal"
        ? [{ name: "../outside-sentinel", body: "CORRUPT" }]
        : attack === "absolute path"
          ? [{ name: sentinel, body: "CORRUPT" }]
          : attack === "symlink absolute escape"
            ? [{ name: "pivot", link: "/" }, { name: `pivot/${sentinel.slice(1)}`, body: "CORRUPT" }]
            : attack === "hardlink parent escape"
              ? [{ name: "pivot", link: "../outside-sentinel", hardlink: true }, { name: "pivot", body: "CORRUPT" }]
              : attack === "symlink chain escape"
                ? [{ name: "first", link: ".." }, { name: "second", link: "first" }, { name: "second/outside-sentinel", body: "CORRUPT" }]
                : [{ name: "pivot", link: ".." }, { name: "pivot/outside-sentinel", body: "CORRUPT" }];
      const archive = path.join(root, "hostile.tar");
      await put(archive, hostileTar(entries));
      ssh.archiveOverride = archive;
      let rejected = false;
      try {
        await hook(params([{ operationId: "untrusted", files: [{ sourcePath: source, targetPath: target, kind: "directory" }] }]));
      } catch { rejected = true; }
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      if (existsSync(ssh.archiveInjected)) {
        expect(rejected, "hostile archive must reject, not sanitize-and-report-success").toBe(true);
      } else {
        // Non-archive enumeration has no tar trust boundary to attack. Prove
        // an actual transfer occurred rather than silently skipping the test.
        expect(rejected).toBe(false);
        expect(await readFile(path.join(target, "safe"), "utf8")).toBe("safe");
      }
    }, TIMEOUT);
  }

  async function receiveHostile(entries: Parameters<typeof hostileTar>[0], exclude?: string[]) {
    const hook = requireHook("out");
    const source = path.join(root, "sandbox", "source");
    const target = path.join(root, "host", "target");
    await put(path.join(source, "safe"), "safe");
    const archive = path.join(root, "hostile.tar");
    await put(archive, hostileTar([{ name: "safe", body: "safe" }, ...entries]));
    ssh.archiveOverride = archive;
    const run = hook(params([{ operationId: "untrusted", files: [{ sourcePath: source, targetPath: target, kind: "directory", ...(exclude ? { exclude } : {}) }] }]));
    return { run, target };
  }

  for (const [attack, link] of [["absolute", "/etc"], ["parent", "../outside-sentinel"], ["climb after descent", "sub/../.."], ["nested parent", "a/../../x"], ["venv interpreter", "/usr/bin/python3"]] as const) {
    it(`drops a ${attack} symlink target from the guest archive and syncs the rest`, async () => {
      const { run, target } = await receiveHostile([{ name: "pivot", link }, { name: "after", body: "after" }]);
      await run;
      expect(existsSync(ssh.archiveInjected)).toBe(true);
      await expect(lstat(path.join(target, "pivot"))).rejects.toThrow();
      expect(await readFile(path.join(target, "safe"), "utf8")).toBe("safe");
      expect(await readFile(path.join(target, "after"), "utf8")).toBe("after");
    }, TIMEOUT);
  }

  it("rejects a member below a dropped symlink instead of landing it as a real directory", async () => {
    const { run, target } = await receiveHostile([{ name: "pivot", link: "/" }, { name: "pivot/etc/planted", body: "CORRUPT" }]);
    await expect(run).rejects.toThrow();
    expect(existsSync(ssh.archiveInjected)).toBe(true);
    await expect(lstat(path.join(target, "pivot"))).rejects.toThrow();
  }, TIMEOUT);

  it("keeps symlinks that stay inside the target", async () => {
    const { run, target } = await receiveHostile([
      { name: "sub/inner", body: "inner" }, { name: "sub/up", link: "../safe" }, { name: "here", link: "./safe" },
    ]);
    await run;
    expect(existsSync(ssh.archiveInjected)).toBe(true);
    expect(await readlink(path.join(target, "sub", "up"))).toBe("../safe");
    expect(await readFile(path.join(target, "sub", "up"), "utf8")).toBe("safe");
    expect(await readFile(path.join(target, "here"), "utf8")).toBe("safe");
  }, TIMEOUT);

  it("drops runtime-state and mapping-excluded members the guest archive carries", async () => {
    const { run, target } = await receiveHostile([
      { name: ".paperclip-runtime/state", body: "CORRUPT" },
      { name: "nested/.paperclip-runtime/state", body: "CORRUPT" },
      { name: "drop.tmp", body: "CORRUPT" },
      { name: "cache/blob", body: "CORRUPT" },
    ], ["**/*.tmp", "cache"]);
    await run;
    expect(existsSync(ssh.archiveInjected)).toBe(true);
    expect(await readFile(path.join(target, "safe"), "utf8")).toBe("safe");
    expect(existsSync(path.join(target, ".paperclip-runtime"))).toBe(false);
    expect(existsSync(path.join(target, "nested", ".paperclip-runtime"))).toBe(false);
    expect(existsSync(path.join(target, "drop.tmp"))).toBe(false);
    expect(existsSync(path.join(target, "cache"))).toBe(false);
  }, TIMEOUT);
});

describe("host python helper isolation", () => {
  it("never imports a planted stdlib shadow from the working directory during inbound preflight", async () => {
    const marker = path.join(root, "planted-json-ran");
    await put(path.join(root, "json.py"), `open(${JSON.stringify(marker)}, "w").write("ran")\n`);
    const source = path.join(root, "host", "source");
    const target = path.join(root, "sandbox", "target");
    await put(path.join(source, "safe"), "safe");
    await requireHook("in")(params([{ operationId: "isolated-helper", files: [
      { sourcePath: source, targetPath: target, kind: "directory" },
    ] }]));
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(path.join(target, "safe"), "utf8")).toBe("safe");
  }, TIMEOUT);
});

describe("production streaming SSH seam", () => {
  it("streams both binary directions without decoding bytes or accumulating stdout", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const bytes = Buffer.from([0, 255, 128, 10, 0, 13]);
    const parts: Buffer[] = [];
    const sink = new Writable({ write(chunk, _encoding, done) { parts.push(Buffer.from(chunk)); done(); } });
    const result = await transport.runStream(session, "cat", { stdin: Readable.from([bytes]), stdout: sink, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    expect(Buffer.concat(parts)).toEqual(bytes);
  });

  it("propagates downstream backpressure to the input producer with bounded buffering", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    let produced = 0;
    let consumed = 0;
    const source = Readable.from((async function* () {
      for (let i = 0; i < 512; i++) { produced++; yield Buffer.alloc(64 * 1024, 0x91); }
    })(), { highWaterMark: 1 });
    let release: (() => void) | undefined;
    let paused = false;
    const sink = new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) {
      consumed += chunk.length;
      if (!paused) { paused = true; release = () => done(); }
      else done();
    } });
    const transfer = transport.runStream(session, "cat", { stdin: source, stdout: sink, timeoutMs: 10_000 });
    void transfer.catch(() => {});
    try {
      await waitFor(() => paused, "stream never wrote to downstream sink");
      // Give a broken, unbounded pump time to drain the producer while the sink
      // is deliberately stalled. OS pipes and stream high-water marks fit well
      // below this 2 MiB ceiling; the fixture totals 32 MiB.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(produced).toBeLessThanOrEqual(32);
    } finally { release?.(); }
    const result = await transfer;
    expect(result.exitCode).toBe(0);
    expect(consumed).toBe(32 * 1024 * 1024);
    expect(produced).toBe(512);
    expect(result.stdout).toBe("");
  }, TIMEOUT);

  it("fails closed on oversized inline stdout when no streaming sink is supplied", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    await expect(transport.runStream(session, "head -c 8192 /dev/zero", {
      maxOutputBytes: 4096, timeoutMs: 5000,
    })).rejects.toThrow();
  });

  it("raises a source stream failure instead of reporting a partial transfer as successful", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const source = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw new Error("fixture source read failed");
    })());
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    await expect(transport.runStream(session, "cat", { stdin: source, stdout: sink, timeoutMs: 5000 })).rejects.toThrow();
  });

  it("raises a target stream failure instead of reporting a partial transfer as successful", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const sink = new Writable({ write(_chunk, _encoding, done) { done(new Error("fixture target write failed")); } });
    await expect(transport.runStream(session, "printf bytes", { stdout: sink, timeoutMs: 5000 })).rejects.toThrow();
  });

  it("reports a producer's nonzero exit after stdout drains instead of silently succeeding", async () => {
    const transport = requireStreaming();
    const session = ssh.getSession(lease.providerLeaseId!)!;
    let bytes = 0;
    const sink = new Writable({ write(chunk, _encoding, done) { bytes += chunk.length; done(); } });
    const result = await transport.runStream(session, "printf bytes; printf failure >&2; exit 19", { stdout: sink, timeoutMs: 5000 });
    expect(result.exitCode).toBe(19);
    expect(result.stderr).toContain("failure");
    expect(bytes).toBe(5);
  });
});

describe("local transfer harness controls", () => {
  it("maps the configured VM namespace to scratch only at the SSH network boundary", async () => {
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const host = path.join(root, "host", "literal");
    const local = path.join(root, "sandbox", "namespace-probe");
    const sibling = path.join(root, "sandbox-sibling", "literal");
    expect(ssh.remotePath(host)).toBe(host);
    expect(ssh.remotePath(sibling)).toBe(sibling);
    expect(ssh.remotePath(local)).toBe("/home/user/native-sync-fixture/namespace-probe");
    const request = params([{ operationId: "path-control", files: [
      { sourcePath: host, targetPath: local, kind: "file" },
    ] }]);
    expect(request.operations[0].files[0]).toEqual({
      sourcePath: host, targetPath: "/home/user/native-sync-fixture/namespace-probe", kind: "file",
    });
    const result = await ssh.run(session, `printf scratch-only > '${ssh.remotePath(local)}'`, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(await readFile(local, "utf8")).toBe("scratch-only");
    expect(ssh.records.at(-1)?.args.at(-1)).toContain("/home/user/native-sync-fixture/namespace-probe");
  });

  it("preserves an opaque inner shell argument through the local namespace relay", async () => {
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const command = "printf opaque > control-result; cat /proc/$$/cmdline > control-argv";
    const result = await ssh.run(session, `cd '${ssh.remoteRoot}' && /bin/sh -c '${command}'`, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(root, "sandbox", "control-result"), "utf8")).toBe("opaque");
    expect((await readFile(path.join(root, "sandbox", "control-argv"), "utf8")).split("\0")).toContain(command);
  });

  it("propagates a real control command timeout through the relay", async () => {
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const result = await ssh.run(session, "exec sleep 30", { timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
  }, TIMEOUT);

  it("builds a real ustar hardlink rather than a symlink disguised as a hardlink attack", async () => {
    const archive = path.join(root, "hardlink-fixture.tar");
    await put(archive, hostileTar([{ name: "pivot", link: "../outside-sentinel", hardlink: true }]));
    const child = processes.actual!("tar", ["-Ptvf", archive], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
    let listing = "";
    child.stdout!.on("data", (chunk) => { listing += String(chunk); });
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(listing).toContain("link to ../outside-sentinel");
    expect(listing.startsWith("h")).toBe(true);
  });

  it("executes a real local shell and preserves binary stdin/stdout", async () => {
    const session = ssh.getSession(lease.providerLeaseId!)!;
    const result = await ssh.run(session, "cat; printf stderr >&2", { stdin: "control\n", timeoutMs: 5000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "control\n", stderr: "stderr", timedOut: false });
  });

  for (const direction of ["in", "out"] as const) {
    it(`can pause and resume a real ${direction} payload at the partial-write boundary`, async () => {
      const src = path.join(root, "probe-source");
      const dst = path.join(root, "probe-target");
      await put(src, syntheticBytes);
      ssh.armGate(direction);
      const command = direction === "in" ? `cat > '${dst}'` : `cat '${src}'`;
      const child = ssh.spawn("ssh", [command], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr!.resume();
      const closed = once(child, "close");
      const input = direction === "in" ? Readable.from([syntheticBytes]) : Readable.from([]);
      const sink = direction === "out" ? createWriteStream(dst) : new Writable({ write(_chunk, _encoding, done) { done(); } });
      const transfer = Promise.all([pipeline(input, child.stdin!), pipeline(child.stdout!, sink)]);
      void transfer.catch(() => {});
      try {
        await atGate(transfer);
        await waitFor(async () => existsSync(dst) && (await lstat(dst)).size > 0, "relay never wrote partial bytes");
        expect((await lstat(dst)).size).toBeLessThan(syntheticBytes.length);
      } finally { await ssh.releaseGate(); }
      await transfer;
      expect((await closed)[0]).toBe(0);
      expect(await readFile(dst)).toEqual(syntheticBytes);
    }, TIMEOUT);

    it(`can interrupt a real ${direction} payload and expose exit 74`, async () => {
      const src = path.join(root, "probe-source");
      const dst = path.join(root, "probe-target");
      await put(src, syntheticBytes);
      const gate = ssh.armGate(direction, true);
      const command = direction === "in" ? `cat > '${dst}'` : `cat '${src}'`;
      const child = ssh.spawn("ssh", [command], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr!.resume();
      const closed = once(child, "close");
      const input = direction === "in" ? Readable.from([syntheticBytes]) : Readable.from([]);
      const sink = direction === "out" ? createWriteStream(dst) : new Writable({ write(_chunk, _encoding, done) { done(); } });
      const transfer = Promise.all([pipeline(input, child.stdin!), pipeline(child.stdout!, sink)]);
      void transfer.catch(() => {});
      try {
        await atGate(transfer);
        await waitFor(async () => existsSync(dst) && (await lstat(dst)).size > 0, "relay never wrote partial bytes");
      } finally { await ssh.releaseGate(); }
      await Promise.allSettled([transfer]);
      expect((await closed)[0]).toBe(74);
      expect(existsSync(gate.reached)).toBe(true);
      const partial = await readFile(dst);
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan(syntheticBytes.length);
    }, TIMEOUT);
  }

  it("actually substitutes malicious archive bytes at the untrusted stdout boundary", async () => {
    const source = path.join(root, "archive-source");
    await put(path.join(source, "safe"), "safe");
    const bytes = hostileTar([{ name: "../outside", body: "attack" }]);
    const archive = path.join(root, "injected.tar");
    await put(archive, bytes);
    ssh.archiveOverride = archive;
    const child = ssh.spawn("ssh", [`tar -cf - -C '${source}' .`], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.resume();
    const closed = once(child, "close");
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk));
    expect((await closed)[0]).toBe(0);
    expect(existsSync(ssh.archiveInjected)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it("builds valid ustar attack fixtures that the actual tar subprocess can list", async () => {
    const archive = path.join(root, "fixture.tar");
    await put(archive, hostileTar([{ name: "../outside", body: "attack" }, { name: "pivot", link: ".." }]));
    const child = processes.actual!("tar", ["-tf", archive], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
    let listing = "";
    child.stdout!.on("data", (chunk) => { listing += String(chunk); });
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(listing).toContain("../outside");
    expect(listing).toContain("pivot");
  });
});
