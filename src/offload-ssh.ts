import path from "node:path";
import { Readable } from "node:stream";
import type { SshManager, SshSession } from "./ssh.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";
import { commandDigest, offloadError, type OffloadIdentity } from "./offload-journal.js";
import type { GuestController, GuestIdentity, OffloadRunContext } from "./offload-lifecycle.js";
import { isCargoOffline } from "./offload/router.js";
import type { OffloadCommand } from "./offload.js";

export interface SshOffloadGuestDeps {
  ssh: SshManager;
  /** Authorize the key and pin the API-provided host key after every resume. */
  session(sandboxId: string): Promise<SshSession>;
  /** Trusted operator delegation, never an agent-supplied path. */
  cgroupParent: string;
  workspace(sandboxId: string, command: OffloadCommand): Promise<string>;
  stateRoot?: string;
  executable?: string;
  args?: (command: OffloadCommand) => string[];
  /** Per-command nonsecret env allowlist; defaults to the cargo pair. */
  allowedEnv?: (command: OffloadCommand) => string[];
  /** Server-owned profile build env, applied under the validated request env. */
  profileEnv?: (command: OffloadCommand) => Record<string, string>;
  path?: string;
  /** Guest checkout root when the source plans a uv (uv.lock) install, else null. */
  uvVenvRoot?: (command: OffloadCommand) => Promise<string | null>;
  /** Validated leading rustup toolchain selector for cargo cache priming, else null. */
  cargoToolchain?: (command: OffloadCommand) => string | null;
}

/** Concrete Linux cgroup-v2 lifecycle over Boat's existing pinned SSH path.
 * No process-group-only execution is advertised as equivalent containment. */
const FETCH_TIMEOUT_MS = 600_000;
export class SshOffloadGuest implements GuestController {
  private readonly prepared = new Map<string, { sandboxId: string; identity: GuestIdentity }>();
  private readonly sessions = new Map<string, SshSession>();
  constructor(private readonly deps: SshOffloadGuestDeps) {}

  private root(identity: GuestIdentity): string {
    const name = path.posix.basename(identity.cgroupPath);
    if (!/^paperclip-boat-[a-f0-9]{32}$/.test(name)
      || path.posix.dirname(identity.cgroupPath) !== this.deps.cgroupParent) throw offloadError("OFFLOAD_GUEST_OWNERSHIP_UNKNOWN");
    return path.posix.join(this.deps.stateRoot ?? "/tmp", name);
  }

  private async rpc<T>(sandboxId: string, action: string, input: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const session = await this.deps.session(sandboxId);
    this.sessions.set(sandboxId, session);
    const result = await this.deps.ssh.runStream(session,
      buildRemoteCommand(`exec python3 -I -c ${shellQuote(OFFLOAD_SSH_SCRIPT)} ${shellQuote(action)}`),
      { stdin: Readable.from([JSON.stringify(input)]), timeoutMs, maxOutputBytes: 128 * 1024 });
    // Guest diagnostics may contain source or environment bytes. Never reflect
    // them into public broker errors/logs and never interpret SSH 255 as no start.
    if (result.exitCode !== 0 || result.timedOut || result.signal) throw offloadError("OFFLOAD_GUEST_TRANSPORT_UNKNOWN");
    try { return JSON.parse(result.stdout) as T; } catch { throw offloadError("OFFLOAD_GUEST_TRANSPORT_UNKNOWN"); }
  }

  private call<T>(sandboxId: string, action: string, identity: GuestIdentity, extra: Record<string, unknown> = {}) {
    return this.rpc<T>(sandboxId, action, { root: this.root(identity), identity, ...extra });
  }

  async bootId(sandboxId: string): Promise<string> { return this.rpc(sandboxId, "boot"); }
  async preflight(sandboxId: string, _command: OffloadCommand) {
    let eligible = false;
    try { eligible = await this.rpc<boolean>(sandboxId, "preflight", { cgroupParent: this.deps.cgroupParent }); } catch { /* Refuse before spawn. */ }
    return { cgroupV2Delegated: eligible === true, outsideWatchdogVerified: eligible === true };
  }
  async prepare(sandboxId: string, command: OffloadCommand): Promise<GuestIdentity> {
    // Explicit nonsecret command env only; no inherited host/Boat credentials.
    // Node/Python commands travel with an empty env (validateSubmit enforces
    // it); cargo keeps its two validated keys.
    const allowedEnv = this.deps.allowedEnv?.(command) ?? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"];
    if (Object.keys(command.env ?? {}).some((key) => !allowedEnv.includes(key))) {
      throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
    }
    const cwd = await this.deps.workspace(sandboxId, command);
    let executable = command.runner ?? command.executable ?? this.deps.executable ?? "cargo";
    let preparedEnv: Record<string, string> = { ...(this.deps.profileEnv?.(command) ?? {}), ...(command.env ?? {}) };
    let guestPath = this.deps.path ?? "/home/user/.cargo/bin:/usr/local/bin:/usr/bin:/bin";
    // A uv (uv.lock) install lands in a checkout-local .venv that the guest
    // never activates: run the interpreter from the venv and activate it for
    // child processes, so console scripts and bare python subprocesses cannot
    // resolve the system interpreter. The venv path is an absolute guest
    // checkout path plus a validated runner name; every other env key stays
    // empty and the activation applies to that command only.
    if ((command.tool ?? "cargo") === "python") {
      const venvRoot = await this.deps.uvVenvRoot?.(command).catch(() => null);
      if (venvRoot !== null && venvRoot !== undefined) {
        const base = command.runner ?? command.executable ?? this.deps.executable ?? "python";
        if (!base || base.includes("/") || base.includes("\\") || base.includes("\0")
          || base === "." || base === ".." || base.includes("..")) throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
        if (!venvRoot.startsWith("/") || venvRoot.includes("\0") || venvRoot.split("/").includes("..")) {
          throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
        }
        const venvDir = path.posix.join(venvRoot, ".venv");
        const venvBin = path.posix.join(venvDir, "bin");
        executable = path.posix.join(venvBin, base);
        preparedEnv = { ...preparedEnv, VIRTUAL_ENV: venvDir };
        guestPath = `${venvBin}:${guestPath}`;
      }
    }
    // An --offline build cannot download missing crates: prime the guest cargo
    // cache from the lockfile before the command's supervisor exists. Fixed
    // argv only, agent input never reaches a command line; a failing fetch
    // fails the prepare, so the command falls back locally instead of failing
    // remotely. resolve() already kept private-registry sources local.
    if ((command.tool ?? "cargo") === "cargo" && executable === "cargo" && isCargoOffline(command.argv)) {
      await this.fetchLocked(sandboxId, cwd, guestPath, this.deps.cargoToolchain?.(command) ?? null);
    }
    const identity = await this.rpc<GuestIdentity>(sandboxId, "prepare", {
      program: OFFLOAD_SSH_SCRIPT, cgroupParent: this.deps.cgroupParent, stateRoot: this.deps.stateRoot ?? "/tmp",
      cwd,
      executable,
      args: this.deps.args?.(command) ?? command.argv, env: preparedEnv, timeoutMs: command.timeoutMs ?? 120_000,
      path: guestPath,
      base: { companyId: command.companyId, runId: command.runId, commandId: command.commandId,
        digest: commandDigest(command), sandboxId },
    });
    this.prepared.set(identity.cgroupPath, { sandboxId, identity });
    return identity;
  }
  /** `cargo fetch --locked` in the guest cwd. The SSH fence is 10 minutes; the
   * guest-side call gives up first, so a timeout surfaces as INELIGIBLE. */
  private async fetchLocked(sandboxId: string, cwd: string, guestPath: string, toolchain: string | null): Promise<void> {
    const result = await this.rpc<{ exitCode: number }>(sandboxId, "fetch",
      { executable: "cargo", toolchain, cwd, path: guestPath }, FETCH_TIMEOUT_MS);
    if (result.exitCode !== 0) throw offloadError("OFFLOAD_GUEST_INELIGIBLE");
  }
  async armDeadline(sandboxId: string, identity: GuestIdentity): Promise<{ verified: boolean; outsideCommandCgroup: boolean }> {
    return this.call(sandboxId, "arm", identity);
  }
  async inspect(sandboxId: string, identity: GuestIdentity): Promise<{ identity: GuestIdentity; populated: boolean; receipt: string }> {
    return this.call(sandboxId, "inspect", identity);
  }
  async term(sandboxId: string, identity: GuestIdentity): Promise<void> { await this.call(sandboxId, "term", identity); }
  async kill(sandboxId: string, identity: GuestIdentity): Promise<void> { await this.call(sandboxId, "kill", identity); }
  async verifyEmpty(sandboxId: string, identity: GuestIdentity): Promise<boolean> {
    const empty = await this.call<boolean>(sandboxId, "empty", identity);
    // Verified-empty subtrees no longer need shutdown signalling. Keep
    // uncertain/failed verifications tracked; receipts remain readable by ID.
    if (empty === true) this.prepared.delete(identity.cgroupPath);
    return empty;
  }
  async heartbeat(sandboxId: string, identity: GuestIdentity): Promise<void> { await this.call(sandboxId, "heartbeat", identity); }
  async receipt(identity: OffloadIdentity): Promise<unknown> { return this.call(identity.sandboxId, "receipt", identity as GuestIdentity); }

  async runCommand(sandboxId: string, _command: OffloadCommand, context?: OffloadRunContext) {
    if (!context) throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    const { identity } = context;
    await this.call(sandboxId, "start", identity);
    let after = 0;
    for (;;) {
      if (Date.now() > identity.guestDeadline + 15_000) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      const page = await this.call<{ events: Array<{ stream: "stdout" | "stderr"; dataBase64: string }>;
        result: { exitCode: number; seconds: number } | null; supervisorAlive: boolean;
        outputLimitExceeded: boolean }>(sandboxId, "read", identity, { after });
      if (page.outputLimitExceeded) throw offloadError("OFFLOAD_OUTPUT_LIMIT");
      if (!page.supervisorAlive && !page.result && !page.events.length) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      for (const event of page.events) {
        if (!["stdout", "stderr"].includes(event.stream) || typeof event.dataBase64 !== "string") throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        const bytes = Buffer.from(event.dataBase64, "base64");
        if (bytes.toString("base64") !== event.dataBase64) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        await context.output(event.stream, bytes);
        after++;
      }
      if (page.result) return page.result;
      if (!page.events.length) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async shutdown(): Promise<void> {
    // Only this transport's prepared, boot-bound subtrees. No ambient guest
    // process, shared control master, or another pool can be signalled here.
    for (const { sandboxId, identity } of this.prepared.values()) {
      const session = this.sessions.get(sandboxId);
      // The pool may already have stopped this VM. Never reconnect/resume just
      // to tidy ephemeral cgroups; its independent watchdog remains the fence.
      if (!session || !this.deps.ssh.masterAlive(session)) continue;
      await this.kill(sandboxId, identity).catch(() => undefined);
      await this.rpc(sandboxId, "retire", { root: this.root(identity), identity }).catch(() => undefined);
    }
    this.prepared.clear();
    this.sessions.clear();
  }
}
