// Independent, tests-only follow-up against immutable 391fa99. Expectations
// come from the published native-sync contract and concrete review repros;
// no implementation diff was read. Keep the existing acceptance suites intact.
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
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
import { LocalSyncSsh, hostileTar, populatedFiles, put, waitFor } from "./test-support/local-sync-ssh.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TIMEOUT = 20_000;
const payload = randomBytes(2 * 1024 * 1024);
let root: string;
let ssh: LocalSyncSsh;
let lease: PluginEnvironmentLease;
let config: Record<string, unknown>;
let children: ChildProcess[];

async function acquire(executionWorkspaceId = WORKSPACE) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "boat", companyId: COMPANY, environmentId: ENVIRONMENT, config,
    runId: `local-review-${executionWorkspaceId}`, executionWorkspaceId,
  });
}

beforeEach(async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  root = await mkdtemp(path.join(scratch, "native-sync-local-review-"));
  ssh = new LocalSyncSsh(root, processes.actual!);
  children = [];
  processes.spawn.mockReset().mockImplementation((command: string, args: string[] = [], options: SpawnOptions = {}) => {
    const child = ssh.spawn(command, args, options);
    children.push(child);
    return child;
  });
  const clock = { now: () => Date.parse("2026-10-22T18:00:00Z") };
  const boat = new FakeBoat(clock);
  setBoatApiFactoryForTests(() => boat as unknown as BoatApiLike);
  setManagerOverridesForTests({ ssh, now: clock.now, sleep: async () => {} });
  config = { apiKey: "boat_test_only", cliproxyTunnel: false, remoteWorkspaceDir: ssh.remoteRoot };
  await plugin.definition.setup(createFakeContext().ctx as never);
  lease = await acquire();
});

afterEach(async () => {
  await ssh?.cleanup();
  await plugin.definition.onShutdown?.();
  setManagerOverridesForTests({});
  setBoatApiFactoryForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

function host(...parts: string[]) { return path.join(root, "host", ...parts); }
function sandbox(...parts: string[]) { return path.join(root, "sandbox", ...parts); }
function mapping(sourcePath: string, targetPath: string, kind: "file" | "directory" = "file") {
  return { sourcePath, targetPath, kind };
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

function requireHook(direction: "in" | "out") {
  const name = direction === "in" ? "onEnvironmentSyncIn" : "onEnvironmentSyncOut";
  const hook = plugin.definition[name];
  // Assert outside rejects so a missing hook cannot satisfy a refusal test.
  expect(hook, `${name} must exist`).toBeTypeOf("function");
  return hook!;
}

function expectNoInboundPayload(since: number) {
  expect(ssh.records.slice(since).filter((record) => record.command === "ssh")
    .reduce((bytes, record) => bytes + record.stdinBytes, 0),
  "ACP refusal must happen before any payload from this operation").toBe(0);
}

async function atGate(transfer: Promise<unknown>) {
  let finished = false;
  let failure: unknown;
  void transfer.then(() => { finished = true; }, (error) => { failure = error; finished = true; });
  await waitFor(() => {
    if (failure) throw failure;
    if (existsSync(ssh.gate!.reached)) return true;
    if (finished) throw new Error("transfer finished before the mid-payload gate");
    return false;
  }, "transfer never reached the mid-payload gate");
}

describe("inbound ACP preflight honors the same exclusions as transmission", () => {
  // These catch preflight scanning excluded content, mismatched glob forms,
  // overbroad basename rules, and counting omitted files as transferred bytes.
  for (const { exclude, omitted } of [
    { exclude: "vendor/**", omitted: "vendor/custom-runtime/process-sessions/run/command.b64" },
    { exclude: "./vendor/**", omitted: "vendor/custom-runtime/process-sessions/run/command.b64" },
    { exclude: "**/vendor/**", omitted: "nested/vendor/custom-runtime/process-sessions/run/command.b64" },
    { exclude: "vendor", omitted: "nested/vendor/custom-runtime/process-sessions/run/command.b64" },
    { exclude: "command.b64", omitted: "nested/custom-runtime/command.b64" },
    { exclude: "**/command.b64", omitted: "nested/custom-runtime/command.b64" },
  ]) {
    for (const direction of ["in", "out"] as const) {
      it(`${direction}: transfers kept siblings when ${JSON.stringify(exclude)} omits ${omitted}`, async () => {
        // The outbound control proves these exact globs are honored by the
        // real sender, independently of the inbound preflight regression.
        const hook = requireHook(direction);
        const source = direction === "in" ? host("tree") : sandbox("tree");
        const target = direction === "in" ? sandbox("tree") : host("tree");
        await put(path.join(source, "keep.txt"), "yes");
        await put(path.join(source, "nested", "keep.bin"), Buffer.from([0, 255]));
        await put(path.join(source, "vendor-backup", "keep.txt"), "ok");
        await put(path.join(source, omitted), "LITERAL_EXCLUDED_ACP_SENTINEL");
        const request = params([{ operationId: "excluded-acp", files: [{
          ...mapping(source, target, "directory"), exclude: [exclude],
        }] }]);
        const original = structuredClone(request);
        expect(await hook(request)).toEqual({ operations: [
          { operationId: "excluded-acp", filesTransferred: 3, bytesTransferred: 7 },
        ] });
        expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("yes");
        expect(await readFile(path.join(target, "nested", "keep.bin"))).toEqual(Buffer.from([0, 255]));
        expect(await readFile(path.join(target, "vendor-backup", "keep.txt"), "utf8")).toBe("ok");
        expect(existsSync(path.join(target, omitted))).toBe(false);
        expect(await readFile(path.join(source, omitted), "utf8")).toBe("LITERAL_EXCLUDED_ACP_SENTINEL");
        expect(request).toEqual(original);
      });
    }
  }

  it("does not dereference an excluded symlink cycle with followSymlinks true", async () => {
    const hook = requireHook("in");
    await put(host("tree", "keep.txt"), "safe");
    await mkdir(host("tree", "vendor"));
    await symlink("..", host("tree", "vendor", "cycle"));
    expect(await hook(params([{ operationId: "excluded-cycle", files: [{
      ...mapping(host("tree"), sandbox("tree"), "directory"), exclude: ["vendor/**"], followSymlinks: true,
    }] }]))).toEqual({ operations: [
      { operationId: "excluded-cycle", filesTransferred: 1, bytesTransferred: 4 },
    ] });
    expect(await readFile(sandbox("tree", "keep.txt"), "utf8")).toBe("safe");
    expect(existsSync(sandbox("tree", "vendor", "cycle"))).toBe(false);
  }, TIMEOUT);

  it("still refuses a non-excluded ACP member before an earlier benign mapping is sent", async () => {
    const hook = requireHook("in");
    await put(host("first"), "new");
    await put(sandbox("first"), "old");
    await put(host("tree", "vendor", "custom-runtime", "command.b64"), "excluded");
    await put(host("tree", "custom-runtime", "process-sessions", "run", "command.b64"), "refused");
    const since = ssh.records.length;
    await expect(hook(params([{ operationId: "non-excluded-acp", files: [
      mapping(host("first"), sandbox("first")),
      { ...mapping(host("tree"), sandbox("tree"), "directory"), exclude: ["vendor/**"] },
    ] }]))).rejects.toThrow(/ACP|process.session|command\.b64/i);
    expectNoInboundPayload(since);
    expect(await readFile(sandbox("first"), "utf8")).toBe("old");
    expect(existsSync(sandbox("tree"))).toBe(false);
  });
});

describe("valid trailing workspace separators do not break confined command cwd", () => {
  for (const suffix of ["/", "///"]) {
    for (const cwdKind of ["default", "explicit root", "explicit child"] as const) {
      it(`runs with ${cwdKind} cwd after acquiring remoteWorkspaceDir with ${JSON.stringify(suffix)}`, async () => {
        const hook = requireHook("in");
        config.remoteWorkspaceDir = `${ssh.remoteRoot}${suffix}`;
        lease = await acquire("44444444-4444-4444-8444-444444444444");
        const child = cwdKind === "explicit child";
        const target = child ? sandbox("nested") : sandbox();
        await put(host("input"), "uploaded");
        const cwd = cwdKind === "default" ? undefined
          : `${ssh.remoteRoot}${child ? "/nested" : ""}${suffix}`;
        const request = params([{ operationId: "trailing-root", files: [
          mapping(host("input"), path.join(target, "input")),
        ], postUploadCommands: [{ command: "cat input > result; pwd > observed-cwd", cwd }] }]);
        const original = structuredClone(request);
        expect(await hook(request)).toEqual({ operations: [
          { operationId: "trailing-root", filesTransferred: 1, bytesTransferred: 8 },
        ] });
        expect(await readFile(path.join(target, "result"), "utf8")).toBe("uploaded");
        expect((await readFile(path.join(target, "observed-cwd"), "utf8")).trim()).toBe(target);
        expect(existsSync(path.join(root, "result"))).toBe(false);
        expect(request).toEqual(original);
      });
    }
  }

  for (const cwd of [
    "/home/user/native-sync-fixture/./nested/",
    "/home/user/native-sync-fixture/nested/../",
    "/home/user/native-sync-fixture/../outside/",
    "/home/user/native-sync-fixture-sibling/",
  ]) {
    it(`still refuses traversal or outside cwd ${JSON.stringify(cwd)}`, async () => {
      const hook = requireHook("in");
      config.remoteWorkspaceDir = `${ssh.remoteRoot}/`;
      lease = await acquire("44444444-4444-4444-8444-444444444444");
      await mkdir(sandbox("nested"), { recursive: true });
      await put(host("sentinel"), "unchanged");
      await expect(hook(params([{ operationId: "cwd-confinement", files: [], postUploadCommands: [{
        command: `printf CORRUPT > '${host("sentinel")}'`, cwd,
      }] }]))).rejects.toThrow();
      expect(await readFile(host("sentinel"), "utf8")).toBe("unchanged");
    });
  }

  for (const destination of ["inside", "outside"] as const) {
    it(`still refuses a cwd symlink pointing ${destination} with a trailing workspace separator`, async () => {
      const hook = requireHook("in");
      config.remoteWorkspaceDir = `${ssh.remoteRoot}/`;
      lease = await acquire("44444444-4444-4444-8444-444444444444");
      const real = destination === "inside" ? sandbox("real") : host("outside");
      await put(path.join(real, "nested", "sentinel"), "unchanged");
      await symlink(real, sandbox("pivot"));
      await expect(hook(params([{ operationId: "symlink-cwd", files: [], postUploadCommands: [{
        command: "printf CORRUPT > sentinel", cwd: `${ssh.remoteRoot}/pivot/nested/`,
      }] }]))).rejects.toThrow();
      expect(await readFile(path.join(real, "nested", "sentinel"), "utf8")).toBe("unchanged");
    });
  }

  for (const component of [".", ".."]) {
    it(`does not normalize away a forbidden ${component} component in workspace configuration`, async () => {
      config.remoteWorkspaceDir = `${ssh.remoteRoot}/${component}/workspace/`;
      const since = ssh.records.length;
      await expect(acquire("44444444-4444-4444-8444-444444444444")).rejects.toThrow();
      expectNoInboundPayload(since);
    });
  }
});

for (const direction of ["in", "out"] as const) {
  describe(`native ${direction} fail-loud coverage`, () => {
    function locations() {
      return direction === "in"
        ? { source: host("source"), target: sandbox("target", "file") }
        : { source: sandbox("source"), target: host("target", "file") };
    }

    for (const problem of ["directory cycle", "96-hop symlink chain", "256-level directory"] as const) {
      it(`refuses a ${problem} with followSymlinks true and never starts the next operation`, async () => {
        const hook = requireHook(direction);
        const { source, target } = locations();
        await put(path.join(source, "keep.txt"), "safe");
        if (problem === "directory cycle") {
          await symlink(".", path.join(source, "cycle"));
        } else if (problem === "96-hop symlink chain") {
          // Well beyond Linux's symlink-resolution depth, without a cycle.
          for (let index = 0; index < 96; index++) {
            await symlink(index === 95 ? "keep.txt" : `link-${index + 1}`, path.join(source, `link-${index}`));
          }
        } else {
          await put(path.join(source, ...Array<string>(256).fill("d"), "leaf"), "deep");
        }
        const started = Date.now();
        await expect(hook(params([
          { operationId: "bad-links", files: [{ ...mapping(source, target, "directory"), followSymlinks: true }] },
          { operationId: "must-not-start", files: [mapping(path.join(source, "keep.txt"), `${target}-later`)] },
        ]))).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(8000);
        expect(existsSync(`${target}-later`)).toBe(false);
        // No rollback assertion: a failed directory transfer may leave a tree.
      }, TIMEOUT);
    }

    it("times out during payload bytes, preserves the old file and cleans processes/scratch without gate release", async () => {
      const hook = requireHook(direction);
      const { source, target } = locations();
      await put(source, payload);
      await put(target, "complete old contents", 0o600);
      config.timeoutMs = 1500;
      const gate = ssh.armGate(direction);
      const firstChild = children.length;
      const started = Date.now();
      const transfer = hook(params([
        { operationId: "stalled-payload", files: [mapping(source, target)] },
        { operationId: "must-not-start", files: [mapping(source, `${target}-later`)] },
      ]));
      void transfer.catch(() => {});
      await atGate(transfer);
      expect(Number(await readFile(gate.reached, "utf8"))).toBeGreaterThanOrEqual(64 * 1024);
      await waitFor(async () => (await populatedFiles(path.dirname(target)))
        .some((file) => file !== target), "no real partial staging bytes before timeout");
      expect(await readFile(target, "utf8")).toBe("complete old contents");
      // No error-message contract: the unreleased real byte gate plus the
      // bounded elapsed deadline distinguish timeout from command failure.
      await expect(transfer).rejects.toThrow();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(Date.now() - started).toBeLessThan(8000);
      expect(existsSync(gate.release), "test cleanup must not cause the failure being asserted").toBe(false);
      expect(await readFile(target, "utf8")).toBe("complete old contents");
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect(existsSync(`${target}-later`)).toBe(false);
      await waitFor(() => children.slice(firstChild).every((child) => child.exitCode !== null || child.signalCode !== null),
        "timed-out transfer left a producer, extractor or SSH relay running");
      // Observe only after processes exit, before afterEach releases any gate
      // or removes scratch: fixture cleanup must never conceal this residue.
      const remaining = await readdir(path.dirname(target));
      expect(remaining, `timed-out upload must remove its own staging scratch; remaining: ${JSON.stringify(remaining)}`)
        .toEqual([path.basename(target)]);
    }, TIMEOUT);
  });
}

describe("outbound declared tar-member body truncation", () => {
  for (const kind of ["file", "directory"] as const) {
    for (const truncated of [false, true]) {
      it(`${truncated ? "refuses truncated" : "accepts complete"} member bytes for a ${kind} mapping`, async () => {
        const hook = requireHook("out");
        const source = sandbox("source");
        const target = host("target", "result");
        await put(kind === "file" ? source : path.join(source, "payload"), "producer sentinel");
        if (kind === "file") await put(target, "complete old contents", 0o600);
        const body = "x".repeat(64 * 1024);
        const complete = hostileTar([{ name: "payload", body }]);
        const archive = path.join(root, "declared-member.tar");
        // Preserve the valid 512-byte header declaring 65536 body bytes, but
        // deliver just 11: this is body EOF, not merely absent tar terminators.
        await put(archive, truncated ? complete.subarray(0, 512 + 11) : complete);
        ssh.archiveOverride = archive;
        const transfer = hook(params([
          { operationId: "declared-body", files: [mapping(source, target, kind)] },
          { operationId: "must-not-start", files: [mapping(
            kind === "file" ? source : path.join(source, "payload"), `${target}-later`,
          )] },
        ]));
        if (truncated) {
          await expect(transfer).rejects.toThrow();
          expect(existsSync(`${target}-later`)).toBe(false);
          if (kind === "file") {
            expect(await readFile(target, "utf8")).toBe("complete old contents");
            expect((await lstat(target)).mode & 0o777).toBe(0o600);
            expect(await readdir(path.dirname(target))).toEqual([path.basename(target)]);
          }
          // Directories are deliberately nontransactional; no rollback claim.
        } else {
          expect(await transfer).toMatchObject({ operations: [
            { operationId: "declared-body", filesTransferred: 1, bytesTransferred: 65536 },
            { operationId: "must-not-start", filesTransferred: 1, bytesTransferred: 65536 },
          ] });
          expect(await readFile(kind === "file" ? target : path.join(target, "payload"), "utf8")).toBe(body);
        }
        expect(existsSync(ssh.archiveInjected), "the real relay must actually inject the archive bytes").toBe(true);
      }, TIMEOUT);
    }
  }
});
