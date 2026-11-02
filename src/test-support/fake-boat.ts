// An in-memory stand-in for the boat API, shaped like @boatdev/sdk answers
// (dates are Date objects, errors are ResponseError-like with a real Response).

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  type: string;
  ttlSeconds: number | null;
  archiveAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
  dataExpiredAt: Date | null;
  noEnv: boolean;
  monitoring: boolean;
  from: string | null;
  /** As boat reports it: the pinned environment name, or null for a noEnv sandbox. */
  environment: string | null;
  /** As boat reports it: the sandbox still holds its creator's logins. */
  holdsCreatorLogins: boolean;
}

export interface FakeCall {
  method: string;
  args: Record<string, unknown>;
}

export function responseError(status: number, body: Record<string, unknown>): Error & { response: Response } {
  const error = new Error(`Response returned an error code`) as Error & { response: Response };
  error.name = "ResponseError";
  error.response = new Response(JSON.stringify({ ok: false, type: "sandbox.error", status, ...body }), {
    status,
    headers: { "content-type": "application/json" },
  });
  return error;
}

export function trialLimits(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    type: "limits",
    accessTier: "trial",
    canStart: true,
    startBlockedReason: null,
    activeSandboxes: 0,
    maxActiveSandboxes: 2,
    creditBalanceSeconds: 2_000_000,
    creditUsedSeconds: 0,
    trialComputeCapSeconds: 90_000,
    machineTypes: [
      { type: "small", available: true, reason: null },
      { type: "default", available: true, reason: null },
      { type: "large", available: false, reason: "not during the free trial; the first payment unlocks it" },
      { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
    ],
    starts: {
      day: { limit: 75, remaining: 75, used: 0 },
      hour: { limit: 25, remaining: 25, used: 0 },
      minute: { limit: 5, remaining: 5, used: 0 },
      unlimited: false,
    },
    trialLine: "2 boxes, 75 new/day, 25h of 25h compute left, auto-stop max 2h, no large or xlarge types",
    ...overrides,
  };
}

type Failure = Error | ((args: Record<string, unknown>) => Error | null);

export class FakeBoat {
  readonly boxes = new Map<string, FakeSandbox>();
  readonly named = new Map<string, { name: string; status: string; sourceSandboxId: string; createdAt: Date; polls: number }>();
  readonly calls: FakeCall[] = [];
  readonly failures = new Map<string, Failure[]>();
  limitsResponse: Record<string, unknown> = trialLimits();
  usageDollarsPerSecond = 0.00001;
  usageSeconds = new Map<string, number>();
  /** "immediate": stop archives at once; "never": stays archiving; "stays_up": the stop is accepted but the VM still looks up. */
  stopMode: "immediate" | "never" | "stays_up" = "immediate";
  namedSnapshotPolls = 1;
  namedAllowance = { free: 10, used: 0 };
  /** Shared with FakeSsh.timeline: each API method, in call order. */
  timeline: string[] | null = null;
  private counter = 0;

  constructor(private readonly clock: { now: () => number }) {}

  failNext(method: string, failure: Failure): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  private record(method: string, args: Record<string, unknown>): void {
    this.calls.push({ method, args: JSON.parse(JSON.stringify(args ?? {})) });
    this.timeline?.push(method);
    const queue = this.failures.get(method);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      const error = typeof next === "function" ? next(args) : next;
      if (error) throw error;
    }
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private view(sandbox: FakeSandbox): Record<string, unknown> {
    return { ...sandbox, desktopAvailable: false, snapshotAvailable: true };
  }

  private need(id: unknown): FakeSandbox {
    const sandbox = this.boxes.get(String(id));
    if (!sandbox) throw responseError(404, { code: "not_found", message: "sandbox not found" });
    return sandbox;
  }

  addSandbox(partial: Partial<FakeSandbox> & { id: string }): FakeSandbox {
    const now = new Date(this.clock.now());
    const sandbox: FakeSandbox = {
      name: partial.id,
      state: "archived",
      type: "default",
      ttlSeconds: 7200,
      archiveAfter: null,
      createdAt: now,
      updatedAt: now,
      dataExpiredAt: null,
      noEnv: true,
      monitoring: false,
      from: null,
      environment: null,
      holdsCreatorLogins: false,
      ...partial,
    };
    this.boxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  // ---- SDK surface (flat request form) ----

  async create(args: Record<string, unknown> = {}) {
    this.record("create", args);
    this.counter += 1;
    const id = `bx_fake${String(this.counter).padStart(4, "0")}`;
    const ttl = (args.ttlSeconds as number | null | undefined) ?? 3600;
    const now = new Date(this.clock.now());
    const sandbox = this.addSandbox({
      id,
      name: id,
      state: "ready",
      type: (args.type as string) ?? "default",
      ttlSeconds: ttl,
      archiveAfter: ttl == null ? null : new Date(this.clock.now() + ttl * 1000),
      createdAt: now,
      updatedAt: now,
      noEnv: args.noEnv === true,
      monitoring: args.monitoring !== false,
      from: (args.from as string) ?? null,
      // A noEnv create is attached to no environment and holds no logins;
      // otherwise the named (or the account-default) environment applies.
      environment: args.noEnv === true ? null : ((args.environment as string) ?? "base"),
      holdsCreatorLogins: args.noEnv !== true,
    });
    return { ok: true, type: "sandbox.created", status: "ready", ttlSeconds: ttl, sandbox: this.view(sandbox) };
  }

  async get(args: { sandboxId: string }) {
    this.record("get", args);
    return { ok: true, type: "sandbox.info", sandbox: this.view(this.need(args.sandboxId)) };
  }

  async update(args: Record<string, unknown>) {
    this.record("update", args);
    const sandbox = this.need(args.sandboxId);
    if (typeof args.name === "string") sandbox.name = args.name;
    if (typeof args.ttlSeconds === "number") {
      sandbox.ttlSeconds = args.ttlSeconds;
      sandbox.archiveAfter = new Date(this.clock.now() + args.ttlSeconds * 1000);
    }
    sandbox.updatedAt = new Date(this.clock.now());
    return { ok: true, type: "sandbox.info", sandbox: this.view(sandbox) };
  }

  async stop(args: Record<string, unknown>) {
    this.record("stop", args);
    const sandbox = this.need(args.sandboxId);
    if (this.stopMode !== "stays_up") sandbox.state = this.stopMode === "immediate" ? "archived" : "archiving";
    sandbox.updatedAt = new Date(this.clock.now());
    return { ok: true, type: "sandbox.stopping", id: sandbox.id, status: "archiving", sandbox: this.view(sandbox) };
  }

  async resume(args: Record<string, unknown>) {
    this.record("resume", args);
    const sandbox = this.need(args.sandboxId);
    // boat refuses a resume while a stop is still saving the disk.
    if (sandbox.state === "archiving") throw responseError(409, { code: "sandbox_stopping", message: "sandbox is stopping" });
    sandbox.state = "ready";
    if (typeof args.type === "string") sandbox.type = args.type;
    // Resuming as noEnv is one-way on boat: owner secrets are scrubbed from
    // the restored snapshot and later resumes stay noEnv.
    if (args.noEnv === true) {
      sandbox.noEnv = true;
      sandbox.environment = null;
      sandbox.holdsCreatorLogins = false;
    }
    if (typeof args.environment === "string" && args.noEnv !== true) sandbox.environment = args.environment;
    const ttl = typeof args.ttlSeconds === "number" ? args.ttlSeconds : sandbox.ttlSeconds;
    sandbox.ttlSeconds = ttl;
    sandbox.archiveAfter = ttl == null ? null : new Date(this.clock.now() + ttl * 1000);
    sandbox.updatedAt = new Date(this.clock.now());
    return { ok: true, type: "sandbox.resuming", id: sandbox.id, status: "ready", sandbox: this.view(sandbox) };
  }

  async fork(args: Record<string, unknown>) {
    this.record("fork", args);
    this.need(args.sandboxId);
    this.counter += 1;
    const id = `bx_fake${String(this.counter).padStart(4, "0")}`;
    const ttl = (args.ttlSeconds as number | null | undefined) ?? 3600;
    const now = new Date(this.clock.now());
    const sandbox = this.addSandbox({
      id,
      name: id,
      state: "ready",
      type: (args.type as string) ?? "default",
      ttlSeconds: ttl,
      archiveAfter: ttl == null ? null : new Date(this.clock.now() + ttl * 1000),
      createdAt: now,
      updatedAt: now,
      noEnv: args.noEnv !== false,
      monitoring: args.monitoring !== false,
      from: null,
    });
    return { ok: true, type: "sandbox.forked", status: "ready", ttlSeconds: ttl, sandbox: this.view(sandbox) };
  }

  async deleteSandbox(args: Record<string, unknown>) {
    this.record("deleteSandbox", args);
    if (args.xAsciiConfirmDelete !== args.sandboxId) throw responseError(409, { code: "confirmation_required" });
    this.need(args.sandboxId);
    this.boxes.delete(String(args.sandboxId));
    return { ok: true, type: "deletion.accepted", operation: { id: "del_1", status: "accepted" } };
  }

  async sandboxes(args: Record<string, unknown> = {}) {
    this.record("sandboxes", args);
    return {
      ok: true,
      type: "sandbox.list",
      sandboxes: [...this.boxes.values()].map((sandbox) => this.view(sandbox)),
      pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
    };
  }

  async sshKey(args: Record<string, unknown>) {
    this.record("sshKey", args);
    const sandbox = this.need(args.sandboxId);
    if (!["ready", "idle", "running"].includes(sandbox.state)) {
      throw responseError(400, { code: "machine_not_running", message: "machine not running" });
    }
    return {
      ok: true,
      type: "sshkey.added",
      success: true,
      machineIp: "203.0.113.10",
      sshUser: "user",
      sshEndpoint: null,
      hostKey: `ssh-ed25519 AAAAHOSTKEY${sandbox.id}`,
    };
  }

  async usage(args: Record<string, unknown>) {
    this.record("usage", args);
    const sandbox = this.need(args.sandboxId);
    let seconds = this.usageSeconds.get(sandbox.id) ?? 0;
    if (typeof args.since === "string" && typeof args.until === "string") {
      seconds = Math.max(0, (Date.parse(args.until) - Date.parse(args.since)) / 1000);
    }
    return {
      ok: true,
      type: "sandbox.usage",
      sandboxId: sandbox.id,
      sandboxType: sandbox.type,
      billingMultiplier: 1,
      since: new Date(0),
      until: new Date(this.clock.now()),
      seconds,
      dollars: seconds * this.usageDollarsPerSecond,
      secondsPerDollar: 100000,
      running: ["ready", "idle", "running"].includes(sandbox.state),
    };
  }

  async limits(args: Record<string, unknown> = {}) {
    this.record("limits", args);
    return this.limitsResponse;
  }

  async saveNamedSnapshot(args: Record<string, unknown>) {
    this.record("saveNamedSnapshot", args);
    this.need(args.sandboxId);
    const name = String(args.name);
    this.named.set(name, { name, status: "saving", sourceSandboxId: String(args.sandboxId), createdAt: new Date(this.clock.now()), polls: 0 });
    return { ok: true, type: "named_snapshot.saving", status: "saving", snapshot: { name, status: "saving", sourceSandboxId: args.sandboxId } };
  }

  async getNamedSnapshot(args: { name: string }) {
    this.record("getNamedSnapshot", args);
    const snapshot = this.named.get(args.name);
    if (!snapshot) throw responseError(404, { code: "snapshot_not_found" });
    snapshot.polls += 1;
    if (snapshot.polls >= this.namedSnapshotPolls) snapshot.status = "ready";
    return { ok: true, type: "named_snapshot.info", snapshot: { ...snapshot, snapshotId: "snap_1", sizeBytes: 1234 } };
  }

  async deleteNamedSnapshot(args: { name: string }) {
    this.record("deleteNamedSnapshot", args);
    if (!this.named.has(args.name)) throw responseError(404, { code: "snapshot_not_found" });
    this.named.delete(args.name);
    return { ok: true, type: "named_snapshot.deleted" };
  }

  async listNamedSnapshots() {
    this.record("listNamedSnapshots", {});
    return {
      ok: true,
      type: "named_snapshot.list",
      snapshots: [...this.named.values()],
      allowance: { free: this.namedAllowance.free, used: this.namedAllowance.used },
    };
  }
}
