import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseError } from "./test-support/fake-boat.js";
import { EPOCH, command, fixture } from "./test-support/account-admission.fixture.js";

// Offload pool VMs must boot the operator's delegated guest template when the
// driver config names one; the stock image has no cgroup delegation, so the
// guest preflight refuses every remote command on it.
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

describe("offload pool templateSnapshot", () => {
  it("creates pool VMs from the configured named snapshot", async () => {
    const p = f.pool("tmpl-pool", { templateSnapshot: "paperclip-offload-delegated-v1" });
    expect(await p.execute(command("tmpl-a"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")[0]!.args.from).toBe("paperclip-offload-delegated-v1");
  });

  it("omits from when no template is configured", async () => {
    const p = f.pool("plain-pool");
    expect(await p.execute(command("plain-a"))).toMatchObject({ status: "completed" });
    expect("from" in f.boat.callsOf("create")[0]!.args).toBe(false);
  });

  it("fails closed when the named snapshot does not exist", async () => {
    f.boat.failNext("create", responseError(404, { error: "snapshot_not_found" }));
    const p = f.pool("missing-pool", { templateSnapshot: "gone" });
    const result = await p.execute(command("missing-a"));
    expect(result.status).not.toBe("completed");
    expect(f.executions).toHaveLength(0);
  });

  it("keys VM reuse on the template and keeps the legacy key without one", async () => {
    type Keyed = { compatibilityKey(c: ReturnType<typeof command>): string };
    const cmd = command("key-a");
    const legacy = JSON.stringify([cmd.companyId, cmd.repoId, cmd.profileId, cmd.trustDomainId ?? null]);
    const plain = f.pool("key-plain") as unknown as Keyed;
    const tmpl = f.pool("key-tmpl", { templateSnapshot: "paperclip-offload-delegated-v1" }) as unknown as Keyed;
    expect(plain.compatibilityKey(cmd)).toBe(legacy);
    expect(tmpl.compatibilityKey(cmd)).not.toBe(legacy);
    expect(tmpl.compatibilityKey(cmd)).toContain("paperclip-offload-delegated-v1");
  });

  it("does not reuse a VM booted from another image after the template changes", async () => {
    const before = f.pool("swap-pool");
    expect(await before.execute(command("swap-a"))).toMatchObject({ status: "completed" });
    const vm = (before as unknown as { pool: Array<{ compatibilityKey: string }> }).pool[0]!;
    const after = f.pool("swap-pool-2", { templateSnapshot: "paperclip-offload-delegated-v1" }) as unknown as
      { compatibilityKey(c: ReturnType<typeof command>): string };
    expect(vm.compatibilityKey).not.toBe(after.compatibilityKey(command("swap-a")));
  });

  it("uses the latest template selection for later creates on the same executor", async () => {
    const p = f.pool("switch-pool", { maxOffloadVms: 4 });
    const live = p as unknown as { setTemplateSnapshot(name: string | null): void };
    live.setTemplateSnapshot("tmpl-b");
    expect(await p.execute(command("switch-b"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create").at(-1)!.args.from).toBe("tmpl-b");
    live.setTemplateSnapshot(null);
    expect(await p.execute(command("switch-none"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")).toHaveLength(2);           // the tmpl-b VM is not reused for the stock image
    expect("from" in f.boat.callsOf("create").at(-1)!.args).toBe(false);
  });
});

describe("offload pool fork boot", () => {
  it("forks pool VMs from the archived sandbox when no named snapshot is set", async () => {
    f.boat.addSandbox({ id: "bx_archived1", state: "archived" });
    const p = f.pool("fork-pool", { templateSourceSandboxId: "bx_archived1" });
    expect(await p.execute(command("fork-a"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")).toHaveLength(0);
    expect(f.boat.callsOf("fork")).toHaveLength(1);
    expect(f.boat.callsOf("fork")[0]!.args).toMatchObject({ sandboxId: "bx_archived1", monitoring: true, failFast: true, noEnv: true });
  });

  it("fails closed when the archived sandbox is gone", async () => {
    const p = f.pool("fork-missing-pool", { templateSourceSandboxId: "bx_nonexistent" });
    const result = await p.execute(command("fork-missing-a"));
    expect(result.status).not.toBe("completed");
    expect(f.executions).toHaveLength(0);
  });

  it("prefers the named snapshot when both selections are set", async () => {
    f.boat.addSandbox({ id: "bx_archived2", state: "archived" });
    const p = f.pool("fork-precedence-pool", { templateSnapshot: "paperclip-offload-delegated-v1",
      templateSourceSandboxId: "bx_archived2" });
    expect(await p.execute(command("fork-pref-a"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("fork")).toHaveLength(0);
    expect(f.boat.callsOf("create").at(-1)!.args.from).toBe("paperclip-offload-delegated-v1");
  });

  it("keys forked VM reuse on the source id, apart from snapshot and stock keys", async () => {
    type Keyed = { compatibilityKey(c: ReturnType<typeof command>): string };
    const cmd = command("fork-key-a");
    const legacy = JSON.stringify([cmd.companyId, cmd.repoId, cmd.profileId, cmd.trustDomainId ?? null]);
    const plain = f.pool("fork-key-plain") as unknown as Keyed;
    const forked = f.pool("fork-key-src", { templateSourceSandboxId: "bx_archived3" }) as unknown as Keyed;
    const tmpl = f.pool("fork-key-tmpl", { templateSnapshot: "paperclip-offload-delegated-v1" }) as unknown as Keyed;
    expect(plain.compatibilityKey(cmd)).toBe(legacy);
    expect(forked.compatibilityKey(cmd)).not.toBe(legacy);
    expect(forked.compatibilityKey(cmd)).not.toBe(tmpl.compatibilityKey(cmd));
    expect(forked.compatibilityKey(cmd)).toContain("bx_archived3");
    const hostile = f.pool("fork-key-hostile", { templateSnapshot: "fork:bx_archived3" }) as unknown as Keyed;
    expect(hostile.compatibilityKey(cmd)).not.toBe(forked.compatibilityKey(cmd));
  });

  it("uses the latest fork selection for later creates on the same executor", async () => {
    f.boat.addSandbox({ id: "bx_archived4", state: "archived" });
    f.boat.addSandbox({ id: "bx_archived5", state: "archived" });
    const p = f.pool("fork-switch-pool", { maxOffloadVms: 4 });
    const live = p as unknown as { setTemplateSourceSandboxId(id: string | null): void };
    live.setTemplateSourceSandboxId("bx_archived4");
    expect(await p.execute(command("fork-switch-a"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("fork").at(-1)!.args.sandboxId).toBe("bx_archived4");
    live.setTemplateSourceSandboxId("bx_archived5");
    expect(await p.execute(command("fork-switch-b"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("fork")).toHaveLength(2);            // the bx_archived4 VM is not reused for the new source
    expect(f.boat.callsOf("fork").at(-1)!.args.sandboxId).toBe("bx_archived5");
  });
});
