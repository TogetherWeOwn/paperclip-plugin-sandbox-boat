import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { planDependencies } from "./offload/deps-install.js";
import { guestPythonUserBase } from "./offload/guest-toolchain.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { listTrackedFiles, type TrackedFilesFn } from "./offload-secret-scan.js";
import { captureSnapshot, collectAndStage, planPush, SyncError, type SourceManifest } from "./offload-sync.js";
import { hashManifest, SshGuestStore, type MirrorVerification, type SpawnFn } from "./offload-ssh-guest-store.js";
import type { OffloadSync } from "./offload-journal.js";
import type { OffloadCommand } from "./offload.js";
import type { SshManager, SshSession } from "./ssh.js";

export interface SshOffloadSyncDeps {
  ssh: SshManager;
  session(sandboxId: string): Promise<SshSession>;
  /** Drop a stale cached session and re-authorize through the provider. Push retries once through it. */
  refreshSession?(sandboxId: string): Promise<SshSession>;
  sourceRoot(command: OffloadCommand): Promise<string>;
  artifactRoot: string;
  workRoot?: string;
  /** Test seam for the rsync delta spawn. */
  spawn?: SpawnFn;
  /** Tracked-file listing for admission; defaults to the real git listing. Test seam for non-git fixtures. */
  trackedFiles?: TrackedFilesFn;
  /** Clock for upload and artifact retention. */
  now?: () => number;
}

/** Returned artifacts outlive the one-day result retention, then the sweep reclaims them. */
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Delta push into a persistent per-card guest mirror, and bounded staged-only return collection. */
export class SshOffloadSync implements OffloadSync {
  private readonly uploads = new Map<string, { source: string; manifest: SourceManifest; scratch: string; guestDir: string; at: number }>();
  /** Previous manifest per (VM, card mirror): the host-side delta base. A mirror lives on one VM, so a push on another VM never moves it. Verified against the guest marker on every push. */
  private readonly mirrors = new Map<string, SourceManifest>();
  /** Serialize pushes and their installs per mirror: concurrent deltas or installs in one mirror would corrupt it. */
  private readonly mirrorLocks = new Map<string, Promise<void>>();
  /**
   * Mirrors a failed push left unfenced: its guest receiver may still be
   * writing (cleanup failed or was skipped over a dead transport). Keyed
   * like `mirrors` (VM + mirror). An unfenced mirror is never reused: the
   * next push re-kills receivers, wipes it, and fully resyncs first.
   */
  private readonly unfencedMirrors = new Set<string>();
  /** Verified dependency installs: per-VM for global (pip), per mirror checkout for node_modules/.venv. */
  private readonly installed = new Map<string, Set<string>>();
  constructor(private readonly deps: SshOffloadSyncDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  /** Guest-side content-addressed marker root for installed dependencies. */
  depCacheDir(): string { return path.posix.join(this.deps.workRoot ?? "/tmp", "paperclip-boat-deps"); }
  private key(command: OffloadCommand): string {
    return createHash("sha256").update(JSON.stringify([command.companyId, command.runId, command.commandId])).digest("hex");
  }
  /** Mirror scope: one card workspace on one repo. Without a workspace, fall back to per-command isolation. */
  private mirrorKey(command: OffloadCommand): string {
    return createHash("sha256").update(JSON.stringify([command.companyId, command.repoId, command.executionWorkspaceId ?? command.commandId])).digest("hex");
  }
  directory(command: OffloadCommand): string { return path.posix.join(this.deps.workRoot ?? "/tmp", `paperclip-boat-mirror-${this.mirrorKey(command).slice(0, 32)}`); }
  async cwd(_sandboxId: string, command: OffloadCommand): Promise<string> {
    const relative = command.cwdRelative ?? ".";
    if (path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "") || relative.includes("\0")) {
      throw new Error("Offload cwd escapes workspace");
    }
    return path.posix.join(this.directory(command), relative);
  }
  async push(sandboxId: string, command: OffloadCommand): Promise<void> {
    const source = await this.deps.sourceRoot(command);
    if (!path.isAbsolute(source) || await realpath(source) !== source) throw new Error("Offload source is not a canonical native workspace");
    await mkdir(this.deps.artifactRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(path.join(this.deps.artifactRoot, "command-"));
    try {
      const frozen = path.join(scratch, "source");
      await mkdir(frozen, { mode: 0o700 });
      // Tracked files only, re-checked at push time (resolve() already gated
      // admission): a source that stopped being a git work tree, or gained a
      // secret-shaped tracked file, since admission never reaches the guest.
      const tracked = await (this.deps.trackedFiles ?? listTrackedFiles)(source).catch(() => null);
      if (!tracked || tracked.size === 0) {
        throw new SyncError("SYNC_NOT_GIT_WORKTREE", `refusing to sync ${source}: not a git work tree with tracked files; the command stays local.`);
      }
      const { manifest } = await captureSnapshot(source, frozen, { onlyPaths: tracked, scanForSecrets: true });
      const guestDir = this.directory(command);
      const mirrorKey = this.mirrorKey(command);
      await this.withMirrorLock(mirrorKey, async () => {
        await this.pushLocked(sandboxId, guestDir, mirrorKey, manifest, frozen);
        await this.installDependencies(sandboxId, command, source, guestDir);
      });
      this.uploads.set(this.key(command), { source, manifest, scratch, guestDir, at: this.now() });
      await rm(frozen, { recursive: true, force: true });
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  private async withMirrorLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mirrorLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.mirrorLocks.set(key, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  /** Plan against the stored manifest, verify the guest agrees, then push only the delta. */
  private async pushLocked(sandboxId: string, guestDir: string, key: string, manifest: SourceManifest, frozen: string): Promise<void> {
    const baseKey = `${sandboxId}:${key}`;
    let stored = this.mirrors.get(baseKey) ?? null;
    const planned = manifest.files.map((file) => file.path);
    const openStore = async (session: SshSession): Promise<SshGuestStore> =>
      new SshGuestStore({ ssh: this.deps.ssh, session, spawn: this.deps.spawn });
    // A resumed VM has a new machine, IP and host key: the stale cached
    // session fails at first contact, and exactly one refresh re-authorizes
    // through the provider before the retry. Warm commands reuse the master.
    // Later ops run on the proven session: their failures are deterministic
    // and never evict it. Sync and parse errors are deterministic too: a bad
    // planned path or a malformed envelope fails identically after a refresh.
    // Files the delta against the stored manifest would skip must prove their
    // guest content still hashes to the manifest: the marker is guest-writable,
    // so marker agreement alone never skips a content check.
    const delta = planPush(stored, manifest);
    const deltaPaths = new Set(delta.toSend.map((file) => file.path));
    // Null-prototype: a source file literally named "__proto__" must keep its
    // hash as an own key instead of being swallowed by the prototype setter.
    const expectedHashes: Record<string, string> = Object.create(null) as Record<string, string>;
    if (stored !== null) {
      for (const file of manifest.files) {
        if (!deltaPaths.has(file.path)) expectedHashes[file.path] = file.sha256;
      }
    }
    let store = await openStore(await this.deps.session(sandboxId));
    let verification: MirrorVerification;
    try {
      verification = await store.verifyMirror(guestDir, planned, expectedHashes);
    } catch (error) {
      if (!this.deps.refreshSession || error instanceof SyncError || error instanceof SyntaxError) throw error;
      store = await openStore(await this.deps.refreshSession(sandboxId));
      verification = await store.verifyMirror(guestDir, planned, expectedHashes);
    }
    // A wipe removes the marker with the rest of the mirror: treat it as gone.
    let marker = verification.suspect === null ? verification.marker : null;
    if (this.unfencedMirrors.has(baseKey)) {
      // Fence before any reuse: prove no receiver from the failed push can
      // still write, then wipe — a marker alone proves neither. If the kill
      // cannot prove that, this throws, nothing is written, and the mirror
      // stays unfenced for the next attempt.
      await store.killStalledReceivers(guestDir);
      await store.wipeMirror(guestDir);
      this.unfencedMirrors.delete(baseKey);
      marker = null;
      stored = null;
    } else if (verification.suspect !== null) {
      await store.wipeMirror(guestDir);
    } else if (stored === null && marker !== null) {
      // A marker without a stored manifest predates this worker (restart or
      // upgrade): the mirror may hold files no current admission would send,
      // and no delta base exists to prune them. Wipe before the full resync.
      await store.wipeMirror(guestDir);
      marker = null;
    }
    const trusted = stored !== null && marker !== null
      && marker.mirrorKey === key && marker.manifestHash === hashManifest(stored);
    // The wipe, or a lost mirror (no marker: new machine, /tmp not in the boat
    // snapshot), removed checkout-local installs too; the install must run again.
    if (marker === null) this.installed.delete(`mirror:${sandboxId}:${guestDir}`);
    // Never trust the stored manifest alone: a missing or disagreeing guest
    // marker (fresh VM, new machine, failed marker write) fully resyncs,
    // which also repairs content drift in tracked files via rsync --checksum.
    // Known deletions are still pruned: they are a property of the host tree,
    // not of the guest state.
    const plan = planPush(trusted ? stored : null, manifest);
    const stale = trusted ? plan.toDeleteFromMirror : planPush(stored, manifest).toDeleteFromMirror;
    // Resend any skipped file whose guest bytes no longer match the manifest
    // (tampered mirror sources are repaired before the command runs).
    let toSend = plan.toSend;
    if (trusted && verification.mismatched.length > 0) {
      const plannedPaths = new Set(toSend.map((file) => file.path));
      const resend = manifest.files.filter((file) =>
        verification.mismatched.includes(file.path) && !plannedPaths.has(file.path));
      toSend = [...toSend, ...resend];
    }
    if (toSend.length > 0) {
      try {
        await store.push(frozen, toSend, guestDir);
      } catch (error) {
        if ((error as { receiverMayBeLive?: unknown } | null)?.receiverMayBeLive === true) {
          this.unfencedMirrors.add(baseKey);
        }
        throw error;
      }
    }
    if (stale.length > 0) await store.pruneMirror(guestDir, stale);
    const fresh = hashManifest(manifest);
    if (marker?.manifestHash !== fresh || marker?.mirrorKey !== key) {
      await store.writeMarker(guestDir, { version: 1, mirrorKey: key, manifestHash: fresh });
    }
    this.mirrors.set(baseKey, manifest);
  }
  /**
   * Install Node/Python dependencies on the guest from the source lockfile.
   * Frozen sync excludes dependency dirs, so a checkout without node_modules
   * cannot run until this installs them. Global installs (pip) run once per
   * lockfile hash per VM (guest-side marker plus an in-memory set); a warm
   * pool VM reuses them across runs. Checkout-local installs (npm/pnpm/yarn,
   * uv: node_modules/.venv live inside the persistent per-card mirror) run
   * once per mirror checkout per lockfile hash; a worker restart reinstalls
   * them once. Cargo checkouts skip this entirely.
   */
  async installDependencies(sandboxId: string, command: OffloadCommand, source: string, guestDir: string): Promise<void> {
    if ((command.tool ?? "cargo") === "cargo") return;
    const plan = await planDependencies(source, command.tool);
    if (!plan) {
      // resolve() keeps lockfile-less commands local before any VM is spent;
      // reaching here means the source changed under us. Never run unlocked.
      throw new Error("Offload node/python commands need a lockfile; refusing unlocked install");
    }
    // node_modules/.venv are checkout-local inside the persistent per-card
    // mirror: reinstall when the mirror or the lockfile hash changes, never
    // once per command. Only global installs (pip) share a per-VM cache.
    const checkoutLocal = plan.installs.some((item) => item.lockfile !== "requirements.txt");
    const installedKey = checkoutLocal ? `mirror:${sandboxId}:${guestDir}` : `vm:${sandboxId}`;
    if (!checkoutLocal) {
      const done = this.installed.get(installedKey);
      if (done?.has(plan.hash)) return;
      const session = await this.deps.session(sandboxId);
      const marker = path.posix.join(this.depCacheDir(), `${plan.hash}.ok`);
      const check = await this.deps.ssh.runStream(session,
        buildRemoteCommand(`exec test -f ${shellQuote(marker)}`), { timeoutMs: 15_000 });
      if (check.exitCode === 0 && !check.timedOut && !check.signal) {
        this.markInstalled(installedKey, plan.hash);
        return;
      }
    } else if (this.installed.get(installedKey)?.has(plan.hash)) {
      return;
    }
    const session = await this.deps.session(sandboxId);
    const steps = plan.installs
      .map((item) => `cd ${shellQuote(guestDir)} && ${item.install.map(shellQuote).join(" ")}`)
      .join(" && ");
    // Global installs record the shared marker; checkout-local installs run
    // inside the per-card guestDir and are remembered per mirror checkout.
    // pip may fall back to a user-site install when system site-packages is
    // not writable: pin PYTHONUSERBASE to the per-VM toolchain root the
    // command itself runs with, not the SSH session's HOME, which the
    // command never sees (it runs under a fresh per-command HOME).
    const script = checkoutLocal ? steps
      : `export PYTHONUSERBASE=${shellQuote(guestPythonUserBase(this.deps.workRoot ?? "/tmp", sandboxId))} && ${steps} && mkdir -p ${shellQuote(this.depCacheDir())} && touch ${shellQuote(path.posix.join(this.depCacheDir(), `${plan.hash}.ok`))}`;
    // Checkout-local node_modules/.venv match only the last installed lockfile:
    // forget it before the install mutates them, so a failed install of B never
    // leaves A trusted, and remember the one new hash only once it succeeded.
    if (checkoutLocal) this.installed.delete(installedKey);
    const result = await this.deps.ssh.runStream(session,
      buildRemoteCommand(`exec sh -c ${shellQuote(script)}`), { timeoutMs: 600_000, maxOutputBytes: 1_048_576 });
    if (result.exitCode !== 0 || result.timedOut || result.signal) {
      throw new Error("Offload dependency install failed; no command ran");
    }
    this.markInstalled(installedKey, plan.hash);
  }
  private markInstalled(installedKey: string, hash: string): void {
    let done = this.installed.get(installedKey);
    if (!done) {
      done = new Set();
      this.installed.set(installedKey, done);
    }
    done.add(hash);
  }
  async collect(sandboxId: string, command: OffloadCommand): Promise<unknown> {
    const upload = this.uploads.get(this.key(command));
    if (!upload) throw new Error("Missing frozen offload manifest; hold for reconciliation");
    const guest = new SshGuestStore({ ssh: this.deps.ssh, session: await this.deps.session(sandboxId), spawn: this.deps.spawn });
    return collectAndStage({ liveRoot: upload.source, uploaded: upload.manifest, guest, guestDir: upload.guestDir,
      stagingDir: path.join(upload.scratch, "returned") });
  }
  async stage(_sandboxId: string, command: OffloadCommand, collected: unknown) {
    const staged = collected as Awaited<ReturnType<typeof collectAndStage>>;
    const upload = this.uploads.get(this.key(command));
    if (!upload) throw new Error("Missing frozen offload manifest");
    // The per-card mirror persists on the guest for the next command: it is the
    // next delta base and keeps dependencies and cargo caches warm. Returned
    // artifacts remain private on persistent host storage for review; VM
    // stop/retirement reclaims the mirror.
    if (!staged.artifactDir) await rm(upload.scratch, { recursive: true, force: true });
    this.uploads.delete(this.key(command));
    return { state: staged.state, changedPaths: staged.changedPaths, conflictPaths: staged.conflictPaths, artifactId: staged.artifactDir };
  }
  /** Drop a failed command's upload and its scratch dir, staged returns included. */
  async discard(_sandboxId: string, command: OffloadCommand): Promise<void> {
    const upload = this.uploads.get(this.key(command));
    if (!upload) return;
    this.uploads.delete(this.key(command));
    await rm(upload.scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  /**
   * Retention: forget uploads and remove command-* scratch dirs, staged
   * returns included, once older than the artifact window. The artifact root
   * may be shared by several pools, so age alone decides; a live command's
   * scratch dir is touched at push and is far younger than the window.
   */
  async collectGarbage(): Promise<void> {
    const cutoff = this.now() - ARTIFACT_RETENTION_MS;
    for (const [id, upload] of this.uploads) if (upload.at < cutoff) this.uploads.delete(id);
    await sweepArtifactRoot(this.deps.artifactRoot, cutoff, new Set([...this.uploads.values()].map((upload) => upload.scratch)));
  }
}

/** Remove command-* scratch dirs under an artifact root last modified before cutoff, except live ones. */
export async function sweepArtifactRoot(artifactRoot: string, cutoff: number, live: ReadonlySet<string> = new Set()): Promise<void> {
  const entries = await readdir(artifactRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of entries) {
    if (!name.startsWith("command-")) continue;
    const dir = path.join(artifactRoot, name);
    if (live.has(dir)) continue;
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory() || info.mtimeMs >= cutoff) continue;
    await rm(dir, { recursive: true, force: true });
  }
}
