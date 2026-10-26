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
