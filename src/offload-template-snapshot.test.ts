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
});
