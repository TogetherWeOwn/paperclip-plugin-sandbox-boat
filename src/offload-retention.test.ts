import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { OffloadJournal, type OffloadSync } from "./offload-journal.js";
import { command as lifecycleCommand, DiskState, EPOCH } from "./test-support/offload-lifecycle-contract.js";
import type { BackendCommand } from "./offload/broker.js";
import type { BoatApiLike } from "./boat-client.js";
import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";

const DAY = 86_400_000;

describe("journal releases the host upload on every non-transport failure", () => {
  let dir: string;
  let state: DiskState;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "retention-journal-"));
    state = new DiskState(path.join(dir, "state.json"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function journalWith(sync: Partial<OffloadSync>, bootId: () => Promise<string> = async () => "boot-a") {
    const discard = vi.fn(async () => {});
    const clock = { t: EPOCH };
    const journal = new OffloadJournal({ journalStore: state.store(),
      guestReceipts: { bootId, read: async () => null },
      resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: EPOCH + DAY }),
      sync: { push: async () => {}, collect: async () => ({}), stage: async () => undefined, discard, ...sync },
    }, () => clock.t, { hold: async () => {}, release: async () => {}, cancel: async () => {} });
    return { journal, discard };
  }
  async function attempt(journal: OffloadJournal, cmd: ReturnType<typeof lifecycleCommand>,
    transport: () => Promise<{ exitCode: number; seconds: number }> = async () => ({ exitCode: 0, seconds: 1 })) {
    return journal.execute(cmd, async () => {
      try {
        const raw = await journal.run("vm", cmd, transport);
        return await journal.finish(cmd, { status: "completed", commandId: cmd.commandId,
          sandboxId: "vm", warm: "cold", queueWaitMs: 0, dollars: 0, ...raw });
      } catch {
        return await journal.finish(cmd, { status: "unknown", code: "OFFLOAD_UNKNOWN", commandId: cmd.commandId, sandboxId: "vm",
          warm: "cold", queueWaitMs: 0, remoteStarted: true, fallbackSafe: false, exitCode: 75, seconds: 0, dollars: 0, reason: "test" });
      }
    });
  }

  it.each(["collect", "stage"] as const)("discards after a %s failure", async (phase) => {
    const { journal, discard } = journalWith({ [phase]: async () => { throw new Error(`${phase} failed`); } });
    const cmd = lifecycleCommand(`fail-${phase}`);
    await attempt(journal, cmd);
    expect(discard).toHaveBeenCalledWith("vm", cmd);
  });

  it("discards after a pre-start failure", async () => {
    const { journal, discard } = journalWith({}, async () => { throw new Error("boot id unavailable"); });
    const cmd = lifecycleCommand("fail-boot");
    expect(await attempt(journal, cmd)).toMatchObject({ status: "unavailable", remoteStarted: false });
    expect(discard).toHaveBeenCalledWith("vm", cmd);
  });

  it("discards when the command is cancelled during push", async () => {
    let release!: () => void;
    const pushing = new Promise<void>((resolve) => { release = resolve; });
    let pushed!: () => void;
    const started = new Promise<void>((resolve) => { pushed = resolve; });
    const { journal, discard } = journalWith({ push: async () => { pushed(); await pushing; } });
    const cmd = lifecycleCommand("cancel-push");
    const result = attempt(journal, cmd);
    await started;
    await journal.cancelCommand(cmd.companyId, cmd.runId, cmd.commandId, "client_signal");
    release();
    expect(await result).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(discard).toHaveBeenCalledWith("vm", cmd);
  });

  it("keeps the upload after a transport failure for receipt reconciliation", async () => {
    const { journal, discard } = journalWith({});
    const cmd = lifecycleCommand("fail-transport");
    await attempt(journal, cmd, async () => { throw new Error("ssh lost"); });
    expect(discard).not.toHaveBeenCalled();
  });
});

describe("stock runtime journal retention", () => {
  let ssh: LoopbackSsh;
  let runtime: SshOffloadRuntime;
  let harness: ReturnType<typeof createFakeContext>;
  let source: string;
  let config: Record<string, unknown>;
  const companyId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", runId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    executionWorkspaceId = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";
  const command = (): BackendCommand => ({ companyId, runId, executionWorkspaceId, commandId: randomUUID(), cardId: "card",
    repoId: "repo:https://github.com/example/public", profileId: "rust-public-1", argv: ["test", "--locked"],
    cwdRelative: ".", env: {}, timeoutMs: 10_000, queueTimeoutMs: 0 });
  const native = (): PluginEnvironmentRealizeWorkspaceParams => ({ driverKey: "boat", companyId, environmentId: "env",
    config: { apiKey: "test-only", maxOffloadVms: 1, offloadIdleStopSeconds: 1 },
    lease: { providerLeaseId: null }, workspace: { localPath: source, metadata: { workspaceRealizationRequest: {
      version: 1, companyId, environmentId: "env", heartbeatRunId: runId, executionWorkspaceId,
      source: { localPath: source, repoUrl: "https://github.com/example/public", projectId: "project", projectWorkspaceId: null },
    } } } });
  const journalKeys = () => [...harness.state.keys()].filter((key) => key.includes("|boat-executor-") && key.includes(`|command/${companyId}/${runId}/`));

  beforeEach(async () => {
    ssh = new LoopbackSsh(); await ssh.start();
    source = path.join(ssh.root, "source"); await mkdir(source);
    await writeFile(path.join(source, "Cargo.lock"), "local-lock");
    await writeFile(path.join(source, "Cargo.toml"), "public source");
    const cgroup = process.env.PAPERCLIP_TEST_CGROUP_PARENT ?? `/sys/fs/cgroup${(await readFile("/proc/self/cgroup", "utf8")).trim().split("::")[1]}`;
    config = { offloadExecutorEnabled: true, offloadGuestTransportEnabled: true,
      offloadCgroupParent: cgroup, offloadArtifactRoot: path.join(ssh.root, "artifacts"),
      offloadAllowedRepos: ["repo:https://github.com/example/public"] };
    const boat = new FakeBoat({ now: Date.now });
    harness = createFakeContext();
    runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: ssh.manager, accountId: "test-only",
      boat: () => boat as unknown as BoatApiLike, session: async () => ssh.session,
      guestOptions: { stateRoot: ssh.root, executable: "/bin/sh", path: "/usr/bin:/bin", args: () => ["-c", "printf done"] } });
    runtime.remember(native());
  }, 15_000);
  afterEach(async () => {
    vi.useRealTimers();
    await runtime?.shutdown(); await ssh?.cleanup();
  }, 20_000);

  it("deletes a finished run's tombstones after the retention window though the host reports no terminatedAt", async () => {
    // The executor captures Date.now at resolution: fake only Date, beforehand.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const executor = (await runtime.resolve(command(), config))!;
    const cmd = command();
    await executor.start(cmd);
    await expect.poll(async () => (await executor.readOutput(companyId, runId, cmd.commandId)).state,
      { timeout: 15_000 }).toMatch(/^(completed|not_started)$/);
    expect(journalKeys()).toHaveLength(1);

    runtime.forgetRun(companyId, runId);
    vi.setSystemTime(Date.now() + 2 * DAY);
    await runtime.sweep();
    const [key] = journalKeys();
    expect(harness.state.get(key!)).toMatchObject({ tombstone: true, runTerminalSeenAt: expect.any(Number) });

    vi.setSystemTime(Date.now() + 29 * DAY);
    await runtime.sweep();
    expect(journalKeys()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * DAY);
    await runtime.sweep();
    expect(journalKeys()).toEqual([]);
  }, 30_000);
});
