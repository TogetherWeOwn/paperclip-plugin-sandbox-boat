// Shell helpers carried over from the exe-dev provider (Paperclip
// packages/plugins/sandbox-providers/exe-dev). The env-file pattern is the
// same: env values never ride argv; they travel over the encrypted ssh stdin
// pipe into a remote 0600 file that the command script sources.
//
// Where the file lives and when it goes differs from exe-dev, on purpose:
//   - It sits in a fresh 0700 directory under /tmp, never in the workspace.
//     The workspace is the git checkout, so a file there can be committed by
//     `git add -A`. boat snapshots save /home/user (every minute, on stop and
//     in named snapshots) but do not save /tmp
//     (docs.boat.dev/snapshots/whats-saved).
//   - It is removed right after it is sourced, before the payload starts, so
//     the payload never sees it on disk. A trailing remove stays as a fallback
//     for a script that did not get that far.
//   - The script runs in a `sh` that `env -u` started without boat's
//     ASCII_TOKEN and BOAT_ID (buildRemoteCommand), so the payload's parent
//     shell never had them in its startup environment (/proc/<pid>/environ
//     keeps a process's startup env even after `unset`). That shell stays
//     the payload's parent and exits with its status, so a payload killed by
//     a signal reports 128+n instead of ssh's 255.
import { randomUUID } from "node:crypto";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function assertValidEnvKeys(entries: Array<[string, string]>): void {
  for (const [key] of entries) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid environment variable key for a boat sandbox: ${key}`);
    }
  }
}

export function buildRemoteEnvFileContents(entries: Array<[string, string]>): string {
  return entries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join("\n") + "\n";
}

/** boat does not save /tmp in any snapshot (docs.boat.dev/snapshots/whats-saved). */
export const REMOTE_ENV_STAGING_ROOT = "/tmp";

/** Where one command's env file is staged on the VM. */
export interface RemoteEnvStage {
  /** A fresh directory, mode 0700, made for this one command. */
  dir: string;
  /** The 0600 env file inside `dir`. */
  path: string;
}

export function newRemoteEnvStage(): RemoteEnvStage {
  const dir = `${REMOTE_ENV_STAGING_ROOT}/paperclip-boat-env-${randomUUID().replace(/-/g, "")}`;
  return { dir, path: `${dir}/env.sh` };
}

/**
 * The remote command that writes stdin into the env file. `mkdir` without -p
 * fails when the path exists, so the file only ever lands in a directory that
 * this command made itself.
 */
export function stageRemoteEnvCommand(stage: RemoteEnvStage): string {
  const dir = shellQuote(stage.dir);
  const file = shellQuote(stage.path);
  return `umask 077 && mkdir -m 700 ${dir} && cat > ${file} && chmod 600 ${file}`;
}

/** Removes the env file and its directory. Safe to run when they are gone. */
export function removeRemoteEnvCommand(stage: RemoteEnvStage): string {
  return `rm -f ${shellQuote(stage.path)}; rmdir ${shellQuote(stage.dir)} 2>/dev/null`;
}

/**
 * boat puts these in every VM, even with noEnv and "safe for third parties"
 * (docs.boat.dev/security#boat-credentials-inside-a-sandbox). ASCII_TOKEN can
 * publish any port of the VM on a public URL; nothing here needs it. boat sets
 * it in the exec env and in an `export ASCII_TOKEN=...` line near the top of
 * ~/.bashrc, above the interactive guard, so every shell that reads ~/.bashrc
 * gets it again.
 */
export const BOAT_VM_CREDENTIAL_VARS = ["ASCII_TOKEN", "BOAT_ID"] as const;

/** Clears the boat VM credentials from the payload's environment. */
export const UNSET_BOAT_VM_CREDENTIALS = `unset ${BOAT_VM_CREDENTIAL_VARS.join(" ")}`;

const ASCII_TOKEN_EXPORT_LINE = "^[[:space:]]*export[[:space:]][[:space:]]*ASCII_TOKEN=";

/**
 * Deletes boat's `export ASCII_TOKEN=...` line from ~/.bashrc, so a shell the
 * agent starts (Claude Code's Bash tool sources the user's shell rc file) does not export the
 * token again. Never fails: it is a best-effort step in VM setup.
 */
export const SCRUB_BASHRC_ASCII_TOKEN = `{ f="$HOME/.bashrc"; if [ -f "$f" ] && grep -q '${ASCII_TOKEN_EXPORT_LINE}' "$f"; then sed -i '/${ASCII_TOKEN_EXPORT_LINE}/d' "$f"; fi; } 2>/dev/null || true`;

// Sources the staged env file, removes it at once, clears the boat VM
// credentials again (a sourced profile can export ASCII_TOKEN from ~/.bashrc),
// tells GNU tar to skip `.paperclip-runtime` members (TAR_SKIP_RUNTIME_DIR;
// after the env file, so a TAR_OPTIONS from the run env keeps the exclude),
// and only then runs the payload. The payload runs as a child, not exec'd:
// this shell never had the credentials in its startup environment
// (buildRemoteCommand), so it may stay alive as the payload's parent, and its
// `exit $rc` hands sshd the payload's status, 128+n for a signal. The payload
// is never the script's last command, so no shell turns it into an implicit
// exec. The trailing remove is a fallback for a script that stopped before the
// first one (a failed `cd` or a failed source); after the payload the file is
// already gone.
export function envSourcingScriptLines(stage: RemoteEnvStage, payloadScript: string): string[] {
  const file = shellQuote(stage.path);
  const remove = removeRemoteEnvCommand(stage);
  return [
    `if [ -f ${file} ]; then . ${file}; fi`,
    `{ ${remove} || true; }`,
    UNSET_BOAT_VM_CREDENTIALS,
    TAR_SKIP_RUNTIME_DIR,
    `${payloadScript}; rc=$?; ${remove}; exit $rc`,
  ];
}

/**
 * The ssh remote command that runs a command script. sshd runs it as
 * `$SHELL -c '<this>'`. That login shell, started with boat's ASCII_TOKEN and
 * BOAT_ID, execs `env`, which execs `sh` with an environment that lacks both,
 * so no process left between sshd and the payload holds them in
 * /proc/<pid>/environ. The `sh` waits for the payload and exits with its
 * status: a payload killed by signal n gives 128+n. (When the payload itself
 * replaced the shell, sshd reported the signal and the ssh client exited 255,
 * which reads as a lost VM.)
 */
export function buildRemoteCommand(script: string): string {
  const unset = BOAT_VM_CREDENTIAL_VARS.map((name) => `-u ${name}`).join(" ");
  return `exec env ${unset} sh -c ${shellQuote(script)}`;
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  remoteEnv?: RemoteEnvStage | null;
}): string {
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  // Source the usual login profiles so the command sees the interactive PATH.
  // No nvm sourcing (SANDBOX-REQUIREMENTS.md firm rule); the image supplies node.
  const lines = [
    "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
  ];
  if (input.cwd) lines.push(`cd ${shellQuote(input.cwd)}`);
  if (input.remoteEnv != null) {
    lines.push(...envSourcingScriptLines(input.remoteEnv, commandParts));
  } else {
    lines.push(UNSET_BOAT_VM_CREDENTIALS, TAR_SKIP_RUNTIME_DIR, `${commandParts}; rc=$?; exit $rc`);
  }
  return lines.join(" && ");
}

// ---------------------------------------------------------------------------
// Paperclip's runtime directory stays out of boat's snapshots.
//
// Paperclip syncs a run's runtime assets (the run MCP config with the run JWT,
// skills, config, the bridge queue, GitHub launchers, upload tarballs) into
// `<root>/.paperclip-runtime/<adapter>/` and re-syncs them for every run. boat
// saves /home/user every minute while a VM runs and at every stop, and keeps
// the older per-minute snapshots for up to about a day. A `.boatignore` in the
// home folder applies to the whole sandbox, with .gitignore rules
// (docs.boat.dev/snapshots/whats-saved#leave-files-out-with-boatignore). So
// before Paperclip syncs anything, the plugin puts the rule
// `.paperclip-runtime/` into `~/.boatignore` (no slash before the name, so it
// matches at any depth) and makes `<root>/.paperclip-runtime` a real 0700
// directory. Measured on boat 2026-10-23: the per-minute and the stop
// snapshot trees then hold each `.paperclip-runtime` as an empty directory,
// nothing below it.
//
// It must be a real directory, not a link. Paperclip writes
// `.paperclip-runtime/.gitignore` before every run that has an agent
// instructions bundle (tog.22 agent-instruction-files.ts,
// instructionGitExcludeProgram) and refuses a `.paperclip-runtime` that is a
// symlink ("Unsafe runtime exclusion directory"), which fails the run before
// it starts. Plugin 0.2.0 linked it into /tmp and every pilot run failed
// there. A bind mount from /tmp is no way out either: boat's snapshots save
// what a bind mount shows under /home/user (measured the same day).
//
// Paperclip's inbound workspace tar carries the host workspace's own
// `.paperclip-runtime/` (repository clones, detached repositories; tog.22
// adapter-utils sandbox-managed-runtime.ts: neither workspaceArchiveExclude
// nor the git overlay copy leaves it out), and Paperclip runs
// `tar -xf <tar> -C <root>`. So every command script tells GNU tar to skip
// `.paperclip-runtime` members (TAR_SKIP_RUNTIME_DIR, below): the host's
// runtime files are not unpacked on the VM, and a tar an agent packs never
// holds the run MCP config. One known gap: a tar that ignores TAR_OPTIONS
// (busybox, bsdtar) is not covered. boat's image ships GNU tar.

/**
 * Exported in every command script, right before the payload: GNU tar reads
 * TAR_OPTIONS ahead of its command line, so each tar the payload runs (Paperclip's
 * workspace extract, its sync-back tar, an agent's own tar) skips every member
 * with a path component named `.paperclip-runtime`, when it extracts, creates
 * or lists an archive. The exclude is not anchored and adds no
 * position-sensitive option, so the command line's own `--exclude`s and member
 * names match as before. The link and its /tmp files are left alone, and an
 * archive an agent packs never holds the run's MCP config. Options already in
 * TAR_OPTIONS stay, after this one.
 */
export const TAR_SKIP_RUNTIME_DIR = 'export TAR_OPTIONS="--exclude=.paperclip-runtime${TAR_OPTIONS:+ $TAR_OPTIONS}"';

/** The `~/.boatignore` rule that leaves every `.paperclip-runtime` directory out of boat's snapshots. */
export const BOATIGNORE_RUNTIME_RULE = ".paperclip-runtime/";

/** The line the runtime-directory script prints last: the directory it made or kept. */
export const RUNTIME_DIR_RESULT_RE = /^paperclip-boat-runtime (made|kept) (\/.+\/\.paperclip-runtime)$/m;

/**
 * A script that prepares `<root>/.paperclip-runtime` before Paperclip syncs
 * anything into it:
 *   - `~/.boatignore` gets the line `.paperclip-runtime/` unless it has it.
 *     Other lines stay; a last line without a newline gets one first.
 *   - A real directory is kept, with its files, and made 0700 (one that
 *     Paperclip's `mkdir -p` made is 0755): a second run on a running VM
 *     keeps the first run's files.
 *   - A symlink (plugin 0.2.0 linked the directory into /tmp; Paperclip
 *     refuses that) or a file is replaced by a fresh 0700 directory. A link's
 *     target is left alone.
 * `<root>` must be under $HOME: only there does the home `.boatignore` apply.
 * Prints `paperclip-boat-runtime made|kept <root>/.paperclip-runtime` and
 * exits 0 only when the directory is real and the rule is in place.
 */
export function runtimeDirScript(root: string): string {
  const cleanRoot = root.trim().replace(/\/+$/, "");
  if (!cleanRoot.startsWith("/") || cleanRoot.length < 2) throw new Error(`runtime root must be an absolute path: ${root}`);
  const rule = shellQuote(BOATIGNORE_RUNTIME_RULE);
  return [
    `root=${shellQuote(cleanRoot)}; dir="$root/.paperclip-runtime"; ign="$HOME/.boatignore"`,
    'case "$root/" in */../*|*/./*) echo "paperclip-boat-runtime: $root is not a plain path" >&2; exit 1;; "$HOME"/?*) ;; *) echo "paperclip-boat-runtime: $root is not under $HOME, where .boatignore applies" >&2; exit 1;; esac',
    `if ! grep -qxF ${rule} "$ign" 2>/dev/null; then`,
    '  if [ -s "$ign" ] && [ -n "$(tail -c 1 "$ign")" ]; then echo >> "$ign" || exit 1; fi',
    `  printf '%s\\n' ${rule} >> "$ign" || exit 1`,
    "fi",
    `grep -qxF ${rule} "$ign" || exit 1`,
    'mkdir -p "$root" || exit 1',
    'if [ -d "$dir" ] && [ ! -L "$dir" ]; then chmod 700 -- "$dir" || exit 1; echo "paperclip-boat-runtime kept $dir"; exit 0; fi',
    'if [ -L "$dir" ] || [ -e "$dir" ]; then rm -f -- "$dir" || exit 1; fi',
    '(umask 077 && mkdir -m 700 "$dir") || exit 1',
    '[ -d "$dir" ] && [ ! -L "$dir" ] || exit 1',
    'echo "paperclip-boat-runtime made $dir"',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run secrets Paperclip itself writes into the VM, outside the run env.
//
// claude_local writes the run's MCP config, `{"mcpServers":{...,"headers":
// {"Authorization":"Bearer <token>"}}}`, where the "Paperclip projects" server
// carries the run JWT (valid 48 h, accepted by the publicly exposed Paperclip
// API). Paperclip syncs it into the VM as the `mcp-config` runtime asset:
// `<remoteCwd>/.paperclip-runtime/<adapter>/mcp-config/mcp-config.json`
// (tog.22: server heartbeat.ts ~25853, claude-local claude-config.ts ~175,
// execute.ts ~658-713; adapter-utils sandbox-managed-runtime.ts ~1531 and
// ~1690). The asset is uploaded as `<adapter dir>/mcp-config-upload.tar`
// (plus `.paperclip-upload*` temp files) and extracted. That path is under
// /home/user, which every boat snapshot saves, and Paperclip never removes it.
// The plugin cannot filter it (it is a file, not env). `~/.boatignore` keeps
// `.paperclip-runtime` out of every snapshot (runtimeDirScript above), and the
// plugin still deletes the file before every stop, delete and template capture
// it makes: a VM whose `~/.boatignore` lost the rule (the agent can edit it)
// would keep it.

/** Runtime asset names, under `<root>/.paperclip-runtime/<adapter>/`, that hold run credentials. */
export const RUNTIME_SECRET_ASSET_GLOBS = ["mcp-config", "mcp-config-upload.tar*"] as const;

/**
 * How deep the catch-all search under $HOME goes, counted to the asset:
 * `$HOME/<ws>/.paperclip-runtime/<adapter>/mcp-config` is depth 4, so a
 * `.paperclip-runtime` directory is looked for down to depth 4 (6 - 2).
 */
export const RUNTIME_SECRET_FIND_MAX_DEPTH = 6;

/**
 * The line the scrub prints last: how many paths it found, how many are left,
 * and whether it could search every directory it had to (`complete`) or not.
 */
export const RUNTIME_SECRET_SCRUB_RESULT_RE = /^paperclip-boat-scrub found=(\d+) left=(\d+) walk=(complete|incomplete)$/m;

/** Exit status of the scrub when nothing is left that it could see, but it could not search everywhere. */
export const RUNTIME_SECRET_SCRUB_INCOMPLETE_EXIT = 3;

// The scan of one or more runtime directories, run as `sh -c "$scan" sh <list|rm> <runtime dir>...`
// (from the root loop, and from `find -exec ... {} +`). For each `<dir>`, an
// asset is exactly `<dir>/<one adapter name>/mcp-config` or
// `<dir>/<one adapter name>/mcp-config-upload.tar*`, never a deeper path such
// as a skill's own `<dir>/claude/skills/mcp-config`. `list` prints each match
// NUL-terminated, `rm` removes it; either way the path is one argument, never
// a line of text. It exits non-zero when it cannot be sure it saw everything:
// a runtime or adapter directory it cannot list or search, or a path that is
// missing only because a directory above it cannot be searched (EACCES, not
// ENOENT). A link whose target is truly gone (a resume on a new machine
// empties /tmp) holds nothing.
const RUNTIME_SCAN_SCRIPT = [
  // reachable <path>: true when <path> exists, or when it is truly absent: the
  // nearest existing directory above it can be searched (stat then fails with ENOENT, not EACCES).
  "reachable() {",
  '  p=$1',
  '  while [ ! -e "$p" ] && [ ! -L "$p" ]; do',
  '    case $p in */*) p=${p%/*}; [ -n "$p" ] || p=/;; *) return 0;; esac',
  "  done",
  '  if [ -d "$p" ] && [ ! -x "$p" ]; then echo "paperclip-boat-scrub: cannot search $p" >&2; return 1; fi',
  "  return 0",
  "}",
  'm=$1; shift; ok=0',
  'for rt do',
  '  if [ ! -e "$rt" ]; then',
  '    if [ -L "$rt" ]; then',
  '      t=$(readlink -- "$rt"; echo x); t=${t%?x}',
  '      case $t in /*) ;; *) t=${rt%/*}/$t;; esac',
  '      reachable "$t" || ok=1',
  '    else',
  '      reachable "$rt" || ok=1',
  '    fi',
  '    continue',
  '  fi',
  '  [ -d "$rt" ] || continue',
  '  if [ ! -r "$rt" ] || [ ! -x "$rt" ]; then echo "paperclip-boat-scrub: cannot list $rt" >&2; ok=1; continue; fi',
  '  for a in "$rt"/* "$rt"/.[!.]* "$rt"/..?*; do',
  '    [ -d "$a" ] || continue',
  '    if [ ! -r "$a" ] || [ ! -x "$a" ]; then echo "paperclip-boat-scrub: cannot list $a" >&2; ok=1; continue; fi',
  `    for p in ${RUNTIME_SECRET_ASSET_GLOBS.map((glob) => `"$a"/${glob}`).join(" ")}; do`,
  '      if [ -e "$p" ] || [ -L "$p" ]; then',
  "        if [ \"$m\" = rm ]; then rm -rf -- \"$p\" || ok=1; else printf '%s\\0' \"$p\" || ok=1; fi",
  "      fi",
  "    done",
  "  done",
  "done",
  "exit $ok",
].join("\n");

/**
 * A script that deletes every `.paperclip-runtime/<adapter>/mcp-config` (and
 * its upload tarball) under each workspace root, under the default
 * `$HOME/paperclip-workspace`, and in every `.paperclip-runtime` under $HOME
 * down to RUNTIME_SECRET_FIND_MAX_DEPTH (skipping node_modules, .git and
 * target). It then looks again and prints
 * `paperclip-boat-scrub found=<n> left=<m> walk=<complete|incomplete>`. It
 * removes nothing else: the checkout, skills (also a skill's own
 * `mcp-config`), config and the bridge stay.
 *
 * Exit 0 only when none is left and the last look searched everything: the
 * scan of every root and runtime directory succeeded (RUNTIME_SCAN_SCRIPT) and
 * so did `find`, whose status and errors are checked, not discarded: a
 * directory under $HOME it cannot read makes the walk incomplete. Exit 1 when
 * something is left, 3 (RUNTIME_SECRET_SCRUB_INCOMPLETE_EXIT) when nothing is
 * left that it could see but the walk was incomplete, 2 when this VM's tools
 * cannot count (nothing verified).
 *
 * A file name may hold a newline (repo content, or an agent steered by a
 * prompt), so no path is ever read back as text to pick what to delete: the
 * scan hands every match to `rm` as one argument. The counts read
 * NUL-terminated paths (a path cannot hold a NUL) from a file under /tmp, so
 * the walk's own status is taken before any counting pipeline; they are
 * deduplicated with `sort -zu` because the default workspace is both a root
 * and under $HOME, and only ever go to `wc`.
 */
export function scrubRuntimeSecretsScript(roots: readonly string[]): string {
  const absolute = [...new Set(roots.map((root) => root.trim().replace(/\/+$/, "")).filter((root) => root.startsWith("/") && root.length > 1))];
  const rootWords = [...absolute.map(shellQuote), '"$HOME/paperclip-workspace"'].join(" ");
  const runtimeDepth = RUNTIME_SECRET_FIND_MAX_DEPTH - 2;
  const find =
    `find "$HOME" -mindepth 1 -maxdepth ${runtimeDepth} \\( -name node_modules -o -name .git -o -name target \\) -prune` +
    ' -o -name .paperclip-runtime -exec sh -c "$scan" sh "$1" {} +';
  return [
    `scan=${shellQuote(RUNTIME_SCAN_SCRIPT)}`,
    // each <list|rm>: scans every root's runtime directory and every one under $HOME; fails when any part could not be searched.
    "each() {",
    "  w=0",
    `  for r in ${rootWords}; do`,
    '    sh -c "$scan" sh "$1" "$r/.paperclip-runtime" || w=1',
    "  done",
    '  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then',
    '    echo "paperclip-boat-scrub: HOME is not a directory; nothing under it was searched" >&2; w=1',
    "  else",
    `    ${find} || w=1`,
    "  fi",
    "  return $w",
    "}",
    // count: n = distinct matches, walk = whether every directory could be searched.
    'count() { if each list > "$t/paths"; then walk=complete; else walk=incomplete; fi; n=$(sort -zu < "$t/paths" | tr -cd \'\\000\' | wc -c | tr -d \' \'); }',
    // A sort or tr that drops NUL-terminated input would count 0 and pass; check the pipeline first.
    "probe=$(printf 'x\\0x\\0y\\0' | sort -zu | tr -cd '\\000' | wc -c | tr -d ' ')",
    'if ! t=$(mktemp -d); then each rm; echo "paperclip-boat-scrub: mktemp failed; nothing verified" >&2; exit 2; fi',
    "trap 'rm -rf -- \"$t\"' EXIT",
    "count; found=$n",
    "each rm",
    "count; left=$n",
    `if [ "$probe" != 2 ]; then echo "paperclip-boat-scrub: this VM's sort/tr cannot count NUL-terminated paths; nothing verified" >&2; exit 2; fi`,
    'echo "paperclip-boat-scrub found=$found left=$left walk=$walk"',
    '[ "$left" = 0 ] || exit 1',
    `[ "$walk" = complete ] || exit ${RUNTIME_SECRET_SCRUB_INCOMPLETE_EXIT}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Supervised remote commands: run a payload in its own process group so a
// multiplexed timeout can cancel the VM-side job, not just the local client.
// ---------------------------------------------------------------------------
// A tiny supervisor, stdlib-only like the transfer helper. It starts the
// payload in a NEW SESSION (its own process group), prints the group id to
// stderr, forwards TERM/INT/HUP to the group, and exits with the payload's
// status (128+n for a signal). argv carries only the marker and the payload
// command; nothing is sourced or eval'd beyond sh -c of that same payload.
// The supervisor shares stdio with the payload (no pipes of its own), then
// closes its own stdout copy after flushing the marker: the channel sees
// payload-stdout EOF as soon as the payload exits, not when the reaping
// supervisor does. Stderr stays shared through marker and diagnostics;
// stdin stays shared so the payload keeps its input.
const RUN_SUPERVISOR_SCRIPT = String.raw`
import ctypes
import os
import signal
import subprocess
import sys
parent_pid = os.getpid()


def bind_parent():
    # A detached payload must not keep the channel's pipes alive if the
    # supervisor is killed. Linux preserves this binding across ordinary exec.
    # This supervisor is single-threaded, so preexec_fn cannot inherit locks
    # held by another thread. Fail closed if the kernel cannot bind the child.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'Cannot bind remote payload to supervisor')
    # The parent may have died between fork and prctl; no signal is retroactive.
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signal.SIGKILL)


child = subprocess.Popen(['/bin/sh', '-c', sys.argv[2]], start_new_session=True, preexec_fn=bind_parent)


def forward(signum, _frame):
    # Forward, then exit at once with 128+n. Never wait() here: a wait inside
    # the handler races the main wait for the child's exit status and can hang
    # instead of reaping. The payload group already got the signal; a caller
    # that needs the group gone escalates itself (see cancelRemoteCommand).
    # Restore defaults first so a second signal kills us immediately.
    for caught in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(caught, signal.SIG_DFL)
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass
    raise SystemExit(128 + signum)


for caught in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(caught, forward)
sys.stderr.write(sys.argv[1] + str(child.pid) + '\n')
sys.stderr.flush()
# Close our own stdout copy before waiting: our caller drains the payload's
# stdout as a pipe, and our duplicate write end would hold that pipe open
# after the payload exits. Stderr stays open: the marker above and the
# payload's diagnostics share it, and our exit closes it promptly because we
# never outlive the payload except to reap it.
os.close(1)
code = child.wait()
sys.exit(code if code >= 0 else 128 - code)
`;

/**
 * Run the payload in its own process group and announce the group's id on
 * stderr before the payload starts. A new session (not a backgrounded
 * subshell: job control is off without a tty, so `&` stays in the caller's
 * group) makes the payload a group leader regardless of sshd behavior, so
 * cancelling the negative pid reaches the payload and its descendants but
 * nothing else. Exit status, stdin and stdout pass through untouched; the
 * marker line is removed from stderr before results return.
 * The supervisor stays on the channel and forwards TERM/INT/HUP to the
 * group, so a plain channel close still interrupts the payload; the
 * explicit cancellation command stays the guarantee for multiplexed timeouts.
 */
export function wrapRemoteCommand(command: string, runId: string): string {
  return `exec python3 -c ${shellQuote(RUN_SUPERVISOR_SCRIPT)} ${shellQuote(`PCSYNC:${runId}:`)} ${shellQuote(command)}`;
}

/** TERM a remote process group, escalate to KILL, wait for it to be gone. Always exits 0: cancellation is best-effort. */
export function cancelRemoteCommand(pgid: number): string {
  return [
    `P=${pgid}`,
    "kill -TERM -$P 2>/dev/null",
    "i=0; while kill -0 -$P 2>/dev/null; do i=$((i+1)); if [ $i -ge 50 ]; then break; fi; sleep 0.02; done",
    "kill -KILL -$P 2>/dev/null",
    "i=0; while kill -0 -$P 2>/dev/null; do i=$((i+1)); if [ $i -ge 25 ]; then break; fi; sleep 0.02; done",
    "exit 0",
  ].join("; ");
}

function isMarkerLine(line: string, prefix: string): boolean {
  return line.startsWith(prefix) && /^\d+$/.test(line.slice(prefix.length));
}

export function parseRunMarker(stderr: string, runId: string): number | null {
  const prefix = `PCSYNC:${runId}:`;
  for (const line of stderr.split("\n")) {
    if (!isMarkerLine(line, prefix)) continue;
    const pid = Number(line.slice(prefix.length));
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
  }
  return null;
}

export function stripRunMarker(stderr: string, runId: string): string {
  const prefix = `PCSYNC:${runId}:`;
  return stderr.split("\n").filter((line) => !isMarkerLine(line, prefix)).join("\n");
}

