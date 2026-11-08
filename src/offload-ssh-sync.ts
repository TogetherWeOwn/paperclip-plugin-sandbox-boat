import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { planDependencies, type DepSelection } from "./offload/deps-install.js";
import { OFFLOAD_BOUNDS } from "./offload/protocol.js";
import { depSelectionProblem } from "./offload/validate.js";
import { guestPythonUserBase } from "./offload/guest-toolchain.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { listTrackedFiles, type TrackedFilesFn } from "./offload-secret-scan.js";
import { captureSnapshot, collectAndStage, planPush, SyncError, type GuestFileState, type SourceManifest } from "./offload-sync.js";
import { hashManifest, SshGuestStore, type MirrorVerification, type SpawnFn } from "./offload-ssh-guest-store.js";
import { commandDigest, type OffloadSync } from "./offload-journal.js";
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

export type CheckedDepSelection = { selection: DepSelection | undefined } | null;

/**
 * Closed consumer check for the explicit dependency selection, shared by
 * admission, installation and venv discovery so all three plan from the same
 * input. Returns null (refuse; never retry with the default plan) for a
 * malformed or unknown-key selection, a non-Python tool, or a selection whose
 * directory is not the command directory. Backend direct calls hit the same
 * gate as routed ones. The planner re-validates the shape and nesting.
 */
export function checkDepSelection(command: OffloadCommand, tool: string | undefined = command.tool): CheckedDepSelection {
  const raw: unknown = command.depSelection;
  if (raw === undefined) return { selection: undefined };
  if (depSelectionProblem(raw, tool ?? "cargo", command.cwdRelative ?? ".") !== null) return null;
  return { selection: raw as DepSelection };
}

/** Returned artifacts outlive the one-day result retention, then the sweep reclaims them. */
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface InstalledDependencies {
  scope: string;
  hash: string;
  uv: boolean;
}

/** Delta push into a persistent per-card guest mirror, and bounded staged-only return collection. */
export class SshOffloadSync implements OffloadSync {
  private readonly uploads = new Map<string, { source: string; manifest: SourceManifest; scratch: string; guestDir: string; sandboxId: string; digest: string; dependencies: InstalledDependencies | null; at: number }>();
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
  /**
   * Mirrors whose collect failed after a completed transport: the guest scan
   * could not be trusted, so the next push wipes and fully resyncs instead of
   * delta-ing against unknown mirror content. Keyed like `mirrors`.
   */
  private readonly suspectMirrors = new Set<string>();
  /**
   * Last complete post-collect guest scan per mirror (host-kept, like
   * `mirrors`): guest content identical to it was already reported by the
   * previous command and must not re-stage as this command's change. Never
   * stored in the guest-writable mirror marker. Keyed like `mirrors`.
   */
  private readonly previousGuestScans = new Map<string, Map<string, GuestFileState>>();
  /** Only the active verified install, never historical membership or guest-writable markers. */
  private readonly installed = new Map<string, InstalledDependencies>();
  /** A transport failure can leave an installer writing; never reuse that scope in this worker. */
  private readonly uncertainInstalls = new Set<string>();
  constructor(private readonly deps: SshOffloadSyncDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
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
    // A failed retry must not leave this command's previous successful identity usable.
    await this.discard(sandboxId, command);
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
        // Plan from the exact bytes uploaded, not a live tree that can change during SSH.
        const dependencies = await this.installDependencies(sandboxId, command, frozen, guestDir);
        this.uploads.set(this.key(command), { source, manifest, scratch, guestDir, sandboxId,
          digest: commandDigest(command), dependencies, at: this.now() });
      });
      await rm(frozen, { recursive: true, force: true });
    } catch (error) {
      this.uploads.delete(this.key(command));
      this.installed.delete(`mirror:${sandboxId}:${this.directory(command)}`);
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
    if (this.suspectMirrors.has(baseKey)) {
      // A collect failure left this mirror's contents unverified: wipe and
      // fully resync rather than reusing it as a delta base.
      await store.wipeMirror(guestDir);
      this.suspectMirrors.delete(baseKey);
      marker = null;
      stored = null;
    }
    const trusted = stored !== null && marker !== null
      && marker.mirrorKey === key && marker.manifestHash === hashManifest(stored);
    // The wipe, or a lost mirror (no marker: new machine, /tmp not in the boat
    // snapshot), removed checkout-local installs too; the install must run again.
    // It also removed every guest-only output the stored scan remembers.
    if (marker === null) {
      this.installed.delete(`mirror:${sandboxId}:${guestDir}`);
      this.previousGuestScans.delete(baseKey);
    }
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
  /** Install from frozen lockfiles; only the last successful plan is reusable.
   * pip mutates a shared environment, not an exact isolated dependency set.
   * A worker restart always reinstalls, ignoring historical guest markers. */
  async installDependencies(sandboxId: string, command: OffloadCommand, source: string, guestDir: string): Promise<InstalledDependencies | null> {
    const checked = checkDepSelection(command, command.tool ?? "cargo");
    if (!checked) throw new Error("Offload dependency selection is invalid for this command; refusing install");
    if ((command.tool ?? "cargo") === "cargo") return null;
    const plan = await planDependencies(source, command.tool, checked.selection);
    if (!plan) {
      throw new Error("Offload node/python commands need a lockfile; refusing unlocked install");
    }
    const checkoutLocal = plan.installs.some((item) => item.lockfile !== "requirements.txt");
    const userBase = guestPythonUserBase(this.deps.workRoot ?? "/tmp", sandboxId);
    const installedKey = checkoutLocal ? `mirror:${sandboxId}:${guestDir}` : `vm:${sandboxId}:${userBase}`;
    return this.withMirrorLock(`install:${installedKey}`, async () => {
      if (this.uncertainInstalls.has(installedKey)) {
        throw new Error("Offload dependency install completion unknown; refusing environment reuse");
      }
      const active = this.installed.get(installedKey);
      if (active?.hash === plan.hash) return active;
      const session = await this.deps.session(sandboxId);
      const steps = plan.installs
        .map((item) => `cd ${shellQuote(guestDir)} && ${item.install.map(shellQuote).join(" ")}`)
        .join(" && ");
      // A user-site fallback must match the command's per-VM PYTHONUSERBASE,
      // never the SSH session's HOME (execution has a fresh command HOME).
      const script = checkoutLocal ? steps : `export PYTHONUSERBASE=${shellQuote(userBase)} && ${steps}`;
      // Invalidate before any mutation, including pip. A failed B cannot leave A trusted.
      this.installed.delete(installedKey);
      let result: Awaited<ReturnType<SshManager["runStream"]>>;
      try {
        result = await this.deps.ssh.runStream(session,
          buildRemoteCommand(`exec sh -c ${shellQuote(script)}`), { timeoutMs: 600_000, maxOutputBytes: 1_048_576 });
      } catch (error) {
        this.uncertainInstalls.add(installedKey);
        throw error;
      }
      if (result.timedOut || result.signal) this.uncertainInstalls.add(installedKey);
      if (result.exitCode !== 0 || result.timedOut || result.signal) {
        throw new Error("Offload dependency install failed; no command ran");
      }
      const installed = { scope: installedKey, hash: plan.hash,
        uv: plan.installs.some((item) => item.lockfile === "uv.lock") };
      this.installed.set(installedKey, installed);
      return installed;
    });
  }
  /** Runtime identity belongs to a successful upload on this sandbox, not the live source. */
  async uvVenvRoot(sandboxId: string, command: OffloadCommand): Promise<string | null> {
    if ((command.tool ?? "cargo") !== "python") return null;
    const upload = this.uploads.get(this.key(command));
    if (!upload || upload.sandboxId !== sandboxId || upload.guestDir !== this.directory(command)
      || upload.digest !== commandDigest(command) || !upload.dependencies
      || this.installed.get(upload.dependencies.scope) !== upload.dependencies) {
      throw new Error("Missing verified frozen Python environment; refusing guest execution");
    }
    return upload.dependencies.uv ? upload.guestDir : null;
  }
  async collect(sandboxId: string, command: OffloadCommand): Promise<unknown> {
    const upload = this.uploads.get(this.key(command));
    if (!upload) throw new Error("Missing frozen offload manifest; hold for reconciliation");
    const guest = new SshGuestStore({ ssh: this.deps.ssh, session: await this.deps.session(sandboxId), spawn: this.deps.spawn });
    const baseKey = `${sandboxId}:${this.mirrorKey(command)}`;
    const staged = await collectAndStage({ liveRoot: upload.source, uploaded: upload.manifest, guest, guestDir: upload.guestDir,
      stagingDir: path.join(upload.scratch, "returned"), previousGuest: this.previousGuestScans.get(baseKey) }).catch((error: unknown) => {
      // A SyncError here is guest mirror content refusing collection (scan
      // validation, traversal, deterministic inspect refusal): retrying the
      // collect can never succeed, so tag it for the journal's truncated
      // path. Transport failures stay untagged and hold for reconciliation.
      if (error instanceof SyncError && Object.isExtensible(error)) {
        (error as SyncError & { collectDeterministic?: boolean }).collectDeterministic = true;
      }
      throw error;
    });
    // Only a complete enumeration can prove what the next command did not
    // change; a truncated scan forgets instead of guessing.
    if (!staged.scan.truncated) this.previousGuestScans.set(baseKey, staged.scan.files);
    else this.previousGuestScans.delete(baseKey);
    return staged;
  }
  /** Remember a mirror whose collect failed: the next push wipes it before reuse. */
  async markSuspect(sandboxId: string, command: OffloadCommand): Promise<void> {
    const baseKey = `${sandboxId}:${this.mirrorKey(command)}`;
    this.suspectMirrors.add(baseKey);
    this.previousGuestScans.delete(baseKey);
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
    await sweepArtifactRoot(this.deps.artifactRoot, cutoff, new Set([...this.uploads.values()].map((upload) => upload.scratch)),
      MAX_ARTIFACT_DIRS, this.now() - OFFLOAD_BOUNDS.resultRetentionMs);
  }
}

/** Retained artifact dirs are count-capped as well as aged out: a mirror that
 * staged on every command must not grow the artifact root without bound. The
 * count cap only reaches dirs older than the result-retention window, so an
 * artifact a retained result can still name is never evicted early. */
export const MAX_ARTIFACT_DIRS = 256;

/** Remove command-* scratch dirs under an artifact root last modified before
 * cutoff, then the oldest beyond the count cap among dirs last modified
 * before countEvictBefore, except live ones. */
export async function sweepArtifactRoot(artifactRoot: string, cutoff: number, live: ReadonlySet<string> = new Set(), maxDirs = MAX_ARTIFACT_DIRS, countEvictBefore = 0): Promise<void> {
  const entries = await readdir(artifactRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const retained: Array<{ dir: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.startsWith("command-")) continue;
    const dir = path.join(artifactRoot, name);
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (!live.has(dir) && info.mtimeMs < cutoff) {
      await rm(dir, { recursive: true, force: true });
    } else {
      retained.push({ dir, mtimeMs: info.mtimeMs });
    }
  }
  const excess = retained.filter(({ dir, mtimeMs }) => !live.has(dir) && mtimeMs < countEvictBefore).sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (retained.length > maxDirs && excess.length > 0) {
    const oldest = excess.shift()!;
    retained.splice(retained.indexOf(oldest), 1);
    await rm(oldest.dir, { recursive: true, force: true });
  }
}
