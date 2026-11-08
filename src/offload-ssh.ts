import path from "node:path";
import { Readable } from "node:stream";
import type { SshManager, SshSession } from "./ssh.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";
import { commandDigest, offloadError, type OffloadIdentity } from "./offload-journal.js";
import type { GuestController, GuestIdentity, OffloadRunContext } from "./offload-lifecycle.js";
import { guestCargoHome, guestCommandHome, guestPythonUserBase } from "./offload/guest-toolchain.js";
import { isCargoOffline } from "./offload/router.js";
import type { OffloadCommand } from "./offload.js";

export interface SshOffloadGuestDeps {
  ssh: SshManager;
  /** Authorize the key and pin the API-provided host key after every resume. */
  session(sandboxId: string): Promise<SshSession>;
  /** Drop the cached session (and its control master) and open a fresh one.
   * Used when a preflight probe proves the current session runs outside
   * the delegated cgroup parent: a connection accepted by a pre-restart sshd
   * listener keeps that listener's config — no template ForceCommand scope —
   * for every multiplexed command, however long the master lives. */
  refreshSession?(sandboxId: string): Promise<SshSession>;
  /** Bounded wait for guest sshd delegation (see `preflight`). Values can
   * only tighten the defaults, which are also the hard caps. */
  delegationWait?: { maxRefreshes?: number; windowMs?: number };
  /** True once the owning runtime is shutting down; the delegation wait
   * stops before any further refresh. */
  closing?: () => boolean;
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
  /** Verified frozen upload's uv checkout root, else null; a missing identity must throw. */
  uvVenvRoot?: (command: OffloadCommand, sandboxId: string) => Promise<string | null>;
  /** Validated leading rustup toolchain selector for cargo cache priming, else null. */
  cargoToolchain?: (command: OffloadCommand) => string | null;
  /** Guest supervisor source, default OFFLOAD_SSH_SCRIPT. Tests override it to
   * emulate a skewed guest clock; production never does. */
  script?: string;
  /** Test seams for the output-poll backoff; defaults are wall clock + setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** First idle delay between output polls; doubles while the guest stays quiet. */
const POLL_IDLE_BASE_MS = 100;
/** Idle backoff ceiling: a quiet command costs about one poll per second, not ten. */
const POLL_IDLE_MAX_MS = 1_000;
/** Floor spacing even when a page carried events, so a trickling guest cannot spin RPCs. */
const POLL_BUSY_FLOOR_MS = 10;

/** Delegation wait, defaults and hard caps at once. A fresh fork or snapshot
 * VM restarts sshd once ~15 s after boot (the template's settle unit), and
 * every connection accepted before that restart stays outside the delegated
 * parent. Refreshes back off 2, 4, 8, 16 s: the last one starts ~30 s plus
 * probe time after the first refusal, inside a 45 s window. */
export const DELEGATION_WAIT_MAX_REFRESHES = 4;
export const DELEGATION_WAIT_WINDOW_MS = 45_000;
const DELEGATION_WAIT_BASE_MS = 2_000;

/** Concrete Linux cgroup-v2 lifecycle over Boat's existing pinned SSH path.
 * No process-group-only execution is advertised as equivalent containment. */
const FETCH_TIMEOUT_MS = 600_000;
/** The guest probe's failure vocabulary (offload-ssh-script `preflight`):
 * the sub-step that refused, the errno name where an OSError caused it, and
 * whether the RPC process itself sits inside the configured delegated
 * parent. Anything else from the guest is not a token and never reaches a
 * log. The placement suffix is optional so a pre-placement guest's bare
 * step/errno tokens still map. */
const GUEST_PROBE_TOKEN = /^(?:parent_invalid|parent_not_delegated|probe_mkdir_failed|probe_admit_failed|probe_outside_failed|probe_kill_failed)(?::E[A-Z]{2,11})?(?::(?:session_delegated|session_not_delegated|session_placement_unknown))?$/;
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

  private script(): string { return this.deps.script ?? OFFLOAD_SSH_SCRIPT; }

  private async rpc<T>(sandboxId: string, action: string, input: Record<string, unknown> = {}, timeoutMs = 15_000, sessionOverride?: SshSession): Promise<T> {
    const session = sessionOverride ?? await this.deps.session(sandboxId);
    this.sessions.set(sandboxId, session);
    const result = await this.deps.ssh.runStream(session,
      buildRemoteCommand(`exec python3 -I -c ${shellQuote(this.script())} ${shellQuote(action)}`),
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
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Elapsed time only, so a monotonic default: a host clock step cannot
    // stretch the window.
    const now = this.deps.now ?? (() => performance.now());
    const startedAt = now();
    let result = await this.probe(sandboxId);
    // A probe that ran OUTSIDE the delegated parent indicts this SSH
    // session, not the template: a control master accepted by a pre-restart
    // sshd listener keeps that listener's parsed config (no template
    // ForceCommand scope) for every multiplexed command. The guest's units
    // restart the listener while a resumed VM's first session opens, and a
    // fresh fork or snapshot VM restarts it once ~15 s after boot — so an
    // immediate reconnect can still reach the pre-settle listener. Drop the
    // cached session and re-run the identical probe over a fresh connection,
    // backing off, until the probe stops reporting an undelegated session or
    // the bounded wait ends. Every other refusal (a delegated session whose
    // admission or kill still failed, an unplaced or transport failure)
    // refreshes nothing: a new connection would land in the same place.
    // Eligibility still requires the probe's literal `true`. The placement
    // suffix is guest-reported like the rest of the token, so it only ever
    // steers this bounded reconnect loop — a forged suffix can waste the
    // window or skip it, never admit a command the identical re-probe would
    // refuse. The wait runs inside the command's host-timed window on its
    // reserved VM, so its seconds are billed to the command like any other
    // pre-start step.
    const maxRefreshes = clampWait(this.deps.delegationWait?.maxRefreshes, DELEGATION_WAIT_MAX_REFRESHES);
    const windowMs = clampWait(this.deps.delegationWait?.windowMs, DELEGATION_WAIT_WINDOW_MS);
    const closing = this.deps.closing ?? (() => false);
    let refreshes = 0;
    let reprobes = 0;
    while (result.cgroupV2Delegated !== true
      && result.ineligibleReason?.endsWith(":session_not_delegated")
      && this.deps.refreshSession && refreshes < maxRefreshes && !closing()) {
      const delayMs = DELEGATION_WAIT_BASE_MS * 2 ** refreshes;
      if (now() - startedAt + delayMs > windowMs) break;
      await sleep(delayMs);
      // A late timer must not start a refresh past the window either, and
      // shutdown can begin during the backoff: its drain is bounded, so a
      // refresh started now could authorize a key and open a control master
      // after the worker already closed every session.
      if (now() - startedAt > windowMs || closing()) break;
      refreshes++;
      let fresh: SshSession;
      // The listener restart itself can refuse a connection: a failed
      // reopen keeps the last refusal and spends one refresh of the budget.
      // A reopen refused because shutdown began ends the wait instead.
      try { fresh = await this.deps.refreshSession(sandboxId); } catch {
        if (closing()) break;
        continue;
      }
      // Pin the re-probe to the refreshed session itself, so a concurrent
      // session change cannot silently substitute a different connection.
      result = await this.probe(sandboxId, fresh);
      reprobes++;
    }
    return refreshes > 0 ? { ...result, delegationRefreshes: refreshes, delegationReprobes: reprobes } : result;
  }
  private async probe(sandboxId: string, sessionOverride?: SshSession): Promise<Awaited<ReturnType<GuestController["preflight"]>>> {
    // Eligibility is still one guest probe exercising real admission, kill
    // and outside placement; both flags stand or fall together. What changed
    // is only the diagnosis: a guest-reported refusal names its probe step
    // as an allowlisted token (re-validated here, so guest bytes never reach
    // a log verbatim), and an RPC transport failure is named separately
    // instead of collapsing into the same false. Refusal semantics are
    // identical — anything but a literal `true` refuses before spawn.
    let raw: unknown;
    try {
      raw = await this.rpc<unknown>(sandboxId, "preflight", { cgroupParent: this.deps.cgroupParent }, 15_000, sessionOverride);
    } catch (error) {
      let suffix = "";
      try {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,56}$/.test(code)) suffix = `:${code}`;
      } catch { /* A throwing accessor contributes no suffix. */ }
      return { cgroupV2Delegated: false, outsideWatchdogVerified: false,
        ineligibleReason: `preflight_rpc_failed${suffix}` };
    }
    if (raw === true) return { cgroupV2Delegated: true, outsideWatchdogVerified: true };
    const probeToken = typeof raw === "string" && GUEST_PROBE_TOKEN.test(raw) ? raw : null;
    return { cgroupV2Delegated: false, outsideWatchdogVerified: false,
      ineligibleReason: probeToken ?? "guest_reported_ineligible" };
  }
  async prepare(sandboxId: string, command: OffloadCommand, timeoutMs?: () => number): Promise<GuestIdentity> {
    // Explicit nonsecret command env only; no inherited host/Boat credentials.
    // Node/Python commands travel with an empty env (validateSubmit enforces
    // it); cargo keeps its two validated keys.
    const allowedEnv = this.deps.allowedEnv?.(command) ?? ["CARGO_TERM_COLOR", "RUST_BACKTRACE"];
    if (Object.keys(command.env ?? {}).some((key) => !allowedEnv.includes(key))) {
      throw offloadError("OFFLOAD_GUEST_INELIGIBLE", "host_env_gate");
    }
    const cwd = await this.deps.workspace(sandboxId, command);
    let executable = command.runner ?? command.executable ?? this.deps.executable ?? "cargo";
    let preparedEnv: Record<string, string> = { ...(this.deps.profileEnv?.(command) ?? {}), ...(command.env ?? {}) };
    // Root-owned directories only: a home-dir entry would let one command's
    // guest code plant a trojan toolchain (e.g. ~/.cargo/bin/cargo) that a
    // later command on the same warm VM then executes. Guest templates must
    // install toolchains under root-owned paths.
    let guestPath = this.deps.path ?? "/usr/local/bin:/usr/bin:/bin";
    // A uv (uv.lock) install lands in a checkout-local .venv that the guest
    // never activates: run the interpreter from the venv and activate it for
    // child processes, so console scripts and bare python subprocesses cannot
    // resolve the system interpreter. The venv path is an absolute guest
    // checkout path plus a validated runner name; every other env key stays
    // empty and the activation applies to that command only.
    if ((command.tool ?? "cargo") === "python") {
      const venvRoot = await this.deps.uvVenvRoot?.(command, sandboxId);
      if (command.depSelection !== undefined && (venvRoot === null || venvRoot === undefined)) {
        throw offloadError("OFFLOAD_GUEST_INELIGIBLE", "python_selected_venv_gate");
      }
      if (venvRoot !== null && venvRoot !== undefined) {
        const base = command.runner ?? command.executable ?? this.deps.executable ?? "python";
        if (!base || base.includes("/") || base.includes("\\") || base.includes("\0")
          || base === "." || base === ".." || base.includes("..")) throw offloadError("OFFLOAD_GUEST_INELIGIBLE", "python_venv_gate");
        if (!venvRoot.startsWith("/") || venvRoot.includes("\0") || venvRoot.split("/").includes("..")) {
          throw offloadError("OFFLOAD_GUEST_INELIGIBLE", "python_venv_gate");
        }
        const venvDir = path.posix.join(venvRoot, ".venv");
        const venvBin = path.posix.join(venvDir, "bin");
        executable = path.posix.join(venvBin, base);
        preparedEnv = { ...preparedEnv, VIRTUAL_ENV: venvDir };
        guestPath = `${venvBin}:${guestPath}`;
      }
    }
    // Fresh per-command HOME: shell hooks or wrapper binaries planted under a
    // persistent home by one command must never be seen by the next command
    // on a reused VM. Toolchain caches live outside HOME in the per-VM
    // toolchain root instead, so a warm VM keeps its crate and pip user-site
    // caches (including what priming fetched) without any of it reaching
    // PATH or another trust domain. The guest supervisor creates exactly
    // these directories under the state root.
    const stateRoot = this.deps.stateRoot ?? "/tmp";
    const cargoHome = guestCargoHome(stateRoot, sandboxId);
    preparedEnv = { ...preparedEnv, HOME: guestCommandHome(stateRoot, command), CARGO_HOME: cargoHome,
      ...((command.tool ?? "cargo") === "python"
        ? { PYTHONUSERBASE: guestPythonUserBase(stateRoot, sandboxId) } : {}) };
    // An --offline build cannot download missing crates: prime the guest cargo
    // cache from the lockfile before the command's supervisor exists. Fixed
    // argv only, agent input never reaches a command line; a failing fetch
    // fails the prepare, so the command falls back locally instead of failing
    // remotely. resolve() already kept private-registry sources local.
    if ((command.tool ?? "cargo") === "cargo" && executable === "cargo" && isCargoOffline(command.argv)) {
      await this.fetchLocked(sandboxId, cwd, guestPath, this.deps.cargoToolchain?.(command) ?? null, cargoHome);
    }
    // After the fetch: its time comes out of the funded window, and a window
    // the fetch used up refuses here, before the supervisor exists.
    const guestTimeoutMs = timeoutMs?.() ?? command.timeoutMs ?? 120_000;
    const identity = await this.rpc<GuestIdentity>(sandboxId, "prepare", {
      program: this.script(), cgroupParent: this.deps.cgroupParent, stateRoot: this.deps.stateRoot ?? "/tmp",
      cwd,
      executable,
      args: this.deps.args?.(command) ?? command.argv, env: preparedEnv, timeoutMs: guestTimeoutMs,
      path: guestPath,
      base: { companyId: command.companyId, runId: command.runId, commandId: command.commandId,
        digest: commandDigest(command), sandboxId },
    });
    this.prepared.set(identity.cgroupPath, { sandboxId, identity });
    return identity;
  }
  /** `cargo fetch --locked` in the guest cwd. The SSH fence is 10 minutes; the
   * guest-side call gives up first, so a timeout surfaces as INELIGIBLE. */
  private async fetchLocked(sandboxId: string, cwd: string, guestPath: string, toolchain: string | null, cargoHome: string): Promise<void> {
    const result = await this.rpc<{ exitCode: number }>(sandboxId, "fetch",
      { executable: "cargo", toolchain, cwd, path: guestPath, cargoHome }, FETCH_TIMEOUT_MS);
    if (result.exitCode !== 0) throw offloadError("OFFLOAD_GUEST_INELIGIBLE", "cargo_fetch_failed");
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
  async heartbeat(sandboxId: string, identity: GuestIdentity): Promise<void> {
    // Durations cross the boundary, never absolute timestamps: the guest
    // renews its own clock-side deadline from renewMs and the host computes
    // its own from the send time, so a skewed guest clock cannot fail or
    // refuse the renewal.
    await this.call(sandboxId, "heartbeat", identity, { renewMs: 30_000 });
  }
  async receipt(identity: OffloadIdentity): Promise<unknown> { return this.call(identity.sandboxId, "receipt", identity as GuestIdentity); }

  async runCommand(sandboxId: string, _command: OffloadCommand, context?: OffloadRunContext) {
    if (!context) throw offloadError("OFFLOAD_GUEST_IDENTITY_INVALID");
    const { identity } = context;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.deps.now ?? Date.now;
    await this.call(sandboxId, "start", identity);
    let after = 0;
    let idleMs = POLL_IDLE_BASE_MS;
    for (;;) {
      if (now() > identity.guestDeadline + 15_000) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      let page: { events: Array<{ stream: "stdout" | "stderr"; dataBase64: string }>;
        result: unknown; supervisorAlive: boolean;
        outputLimitExceeded: boolean };
      try {
        page = await this.call<typeof page>(sandboxId, "read", identity, { after });
      } catch (error) {
        // A read page that outgrows the control RPC's own byte cap is output
        // overflow, not a transport mystery: fail closed with the overflow
        // code so a nonconforming page can never surface as truncated success.
        if (isControlOutputLimit(error)) throw offloadError("OFFLOAD_OUTPUT_LIMIT");
        throw error;
      }
      if (page.outputLimitExceeded) throw offloadError("OFFLOAD_OUTPUT_LIMIT");
      if (!page.supervisorAlive && page.result == null && !page.events.length) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      for (const event of page.events) {
        if (!["stdout", "stderr"].includes(event.stream) || typeof event.dataBase64 !== "string") throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        const bytes = Buffer.from(event.dataBase64, "base64");
        if (bytes.toString("base64") !== event.dataBase64) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
        await context.output(event.stream, bytes);
        after++;
      }
      if (page.result != null) return validatedGuestResult(page.result);
      if (!page.events.length) {
        await sleep(idleMs);
        idleMs = Math.min(POLL_IDLE_MAX_MS, idleMs * 2);
      } else {
        idleMs = POLL_IDLE_BASE_MS;
        await sleep(POLL_BUSY_FLOOR_MS);
      }
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

/** A configured wait value may only tighten its default, which is the cap. */
function clampWait(value: number | undefined, cap: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : cap;
}

/** True for the control-plane byte-cap refusal (see runStreamProcess): the
 * response outgrew the RPC envelope, so the read caller fails it closed. */
function isControlOutputLimit(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "SSH_CONTROL_OUTPUT_LIMIT";
}

/** Guest-reported exit facts are untrusted: only a safe-integer exit code in
 * 0..255 and finite non-negative seconds cross this boundary, with exactly
 * the two fields the supervisor writes. Anything else (a megabyte string, a
 * guest-asserted cancelled/timedOut, an extra key) ends the command unknown
 * instead of entering the journal or the account ledger. */
function validatedGuestResult(value: unknown): { exitCode: number; seconds: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => key !== "exitCode" && key !== "seconds")
    || !Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0 || (result.exitCode as number) > 255
    || typeof result.seconds !== "number" || !Number.isFinite(result.seconds) || (result.seconds as number) < 0) {
    throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  }
  return { exitCode: result.exitCode as number, seconds: result.seconds as number };
}
