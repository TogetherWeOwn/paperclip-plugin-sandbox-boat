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
    lines.push(UNSET_BOAT_VM_CREDENTIALS, `${commandParts}; rc=$?; exit $rc`);
  }
  return lines.join(" && ");
}

// ---------------------------------------------------------------------------
// Paperclip's runtime directory lives under /tmp.
//
// Paperclip syncs a run's runtime assets (the run MCP config with the run JWT,
// skills, config, the bridge queue, GitHub launchers, upload tarballs) into
// `<root>/.paperclip-runtime/<adapter>/` and re-syncs them for every run. boat
// saves /home/user every minute while a VM runs and at every stop, and keeps
// the older per-minute snapshots for up to about a day. /tmp is in none of
// them (docs.boat.dev/snapshots/whats-saved). So `<root>/.paperclip-runtime`
// is made a symlink to a fresh 0700 directory under /tmp, before Paperclip
// syncs anything: the files reach the VM's memory or scratch disk, never a
// snapshot. Paperclip only creates and empties paths below it (`mkdir -p`,
// `rm -rf <asset dir>`), and its workspace wipe and restore skip the name.

/** Where the runtime directories of a VM live. Fixed: the link check below accepts only this shape. */
export const RUNTIME_TMP_PREFIX = "/tmp/paperclip-boat-runtime-";

/** The line the link script prints last: whether it kept the old target or made a new one, and the target. */
export const RUNTIME_LINK_RESULT_RE = /^paperclip-boat-runtime (linked|kept) (\/tmp\/paperclip-boat-runtime-[0-9a-f]{32})$/m;

/** A fresh, unguessable runtime directory name for one VM start (one lease). */
export function newRuntimeTmpDir(): string {
  return `${RUNTIME_TMP_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

/**
 * A script that makes `<root>/.paperclip-runtime` a symlink into /tmp:
 *   - A link to an existing runtime directory of ours (the exact
 *     `/tmp/paperclip-boat-runtime-<32 hex>` shape, a real directory owned by
 *     this user) is kept, so a second run on a running VM does not lose the
 *     first run's files.
 *   - Anything else is replaced by a link to `fresh`, made with `mkdir -m 700`
 *     (it fails when the path exists): a link that dangles because a stop
 *     emptied /tmp, a link elsewhere, a file, or a real directory (from before
 *     this version, or made by something else). A real directory's entries move
 *     into `fresh` first, so they leave the saved disk and a run that uses
 *     them still finds them through the link.
 * Prints `paperclip-boat-runtime linked|kept <target>` and exits 0 only when
 * the link resolves to that target.
 */
export function linkRuntimeDirScript(root: string, fresh: string): string {
  const cleanRoot = root.trim().replace(/\/+$/, "");
  if (!cleanRoot.startsWith("/") || cleanRoot.length < 2) throw new Error(`runtime root must be an absolute path: ${root}`);
  if (!fresh.startsWith(RUNTIME_TMP_PREFIX) || !/^[0-9a-f]{32}$/.test(fresh.slice(RUNTIME_TMP_PREFIX.length))) {
    throw new Error(`runtime directory must be ${RUNTIME_TMP_PREFIX}<32 hex>: ${fresh}`);
  }
  // Spelled out, not [0-9a-f]: a range in a case pattern can follow the locale's collation.
  const ours = `${RUNTIME_TMP_PREFIX}${"[0123456789abcdef]".repeat(32)}`;
  return [
    `root=${shellQuote(cleanRoot)}; link="$root/.paperclip-runtime"; new=${shellQuote(fresh)}`,
    'mkdir -p "$root" || exit 1',
    'if [ -L "$link" ]; then',
    '  t=$(readlink "$link")',
    `  case "$t" in ${ours}) if [ -d "$t" ] && [ ! -L "$t" ] && [ -O "$t" ]; then echo "paperclip-boat-runtime kept $t"; exit 0; fi;; esac`,
    "fi",
    'umask 077 && mkdir -m 700 "$new" || exit 1',
    'if [ -d "$link" ] && [ ! -L "$link" ]; then',
    '  find "$link" -mindepth 1 -maxdepth 1 -exec mv -f -- {} "$new"/ \\; 2>/dev/null',
    '  rm -rf -- "$link" || exit 1',
    'elif [ -L "$link" ] || [ -e "$link" ]; then',
    '  rm -f -- "$link" || exit 1',
    "fi",
    'ln -s "$new" "$link" || exit 1',
    '[ "$(readlink "$link")" = "$new" ] || exit 1',
    'echo "paperclip-boat-runtime linked $new"',
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
// The plugin cannot filter it (it is a file, not env). It links
// `.paperclip-runtime` into /tmp (linkRuntimeDirScript above), so the file
// normally never reaches the saved disk, and it still deletes it before every
// stop, delete and template capture it makes: a VM set up before the link, or
// a link that something replaced with a real directory, would keep it.

/** Runtime asset names, under `<root>/.paperclip-runtime/<adapter>/`, that hold run credentials. */
export const RUNTIME_SECRET_ASSET_GLOBS = ["mcp-config", "mcp-config-upload.tar*"] as const;

/** How deep the catch-all search under $HOME goes (`$HOME/<ws>/.paperclip-runtime/<adapter>/mcp-config` is depth 4). */
export const RUNTIME_SECRET_FIND_MAX_DEPTH = 6;

/** The line the scrub prints last: how many paths it found and how many are left. */
export const RUNTIME_SECRET_SCRUB_RESULT_RE = /^paperclip-boat-scrub found=(\d+) left=(\d+)$/m;

/**
 * A script that deletes every `.paperclip-runtime/<adapter>/mcp-config` (and
 * its upload tarball) under each workspace root, under the default
 * `$HOME/paperclip-workspace`, and anywhere under $HOME up to
 * RUNTIME_SECRET_FIND_MAX_DEPTH (skipping node_modules, .git and target). It
 * then looks again and exits 0 only when none is left, printing
 * `paperclip-boat-scrub found=<n> left=<m>`. It removes nothing else: the
 * checkout, skills, config and the bridge stay.
 *
 * A file name may hold a newline (repo content, or an agent steered by a
 * prompt), so no path is ever read back as text to pick what to delete: `each`
 * hands every match to its command as one argument, from the glob loop or from
 * `find -exec ... {} +`. The counts read NUL-terminated paths (a path cannot
 * hold a NUL), deduplicated with `sort -zu` because the default workspace is
 * both a root and under $HOME; that output only ever goes to `wc`.
 */
export function scrubRuntimeSecretsScript(roots: readonly string[]): string {
  const absolute = [...new Set(roots.map((root) => root.trim().replace(/\/+$/, "")).filter((root) => root.startsWith("/") && root.length > 1))];
  const rootWords = [...absolute.map(shellQuote), '"$HOME/paperclip-workspace"'].join(" ");
  const globs = RUNTIME_SECRET_ASSET_GLOBS.map((glob) => `"$r"/.paperclip-runtime/*/${glob}`).join(" ");
  const findPaths = RUNTIME_SECRET_ASSET_GLOBS.map((glob) => `-path ${shellQuote(`*/.paperclip-runtime/*/${glob}`)}`).join(" -o ");
  const find =
    `find "$HOME" -maxdepth ${RUNTIME_SECRET_FIND_MAX_DEPTH} \\( -name node_modules -o -name .git -o -name target \\) -prune` +
    ` -o \\( ${findPaths} \\) -prune -exec "$@" {} + 2>/dev/null`;
  return [
    // each <command...>: runs `<command...> <path>` for every match, the path as one argument.
    "each() {",
    `  for r in ${rootWords}; do`,
    `    for p in ${globs}; do`,
    `      if [ -e "$p" ] || [ -L "$p" ]; then "$@" "$p"; fi`,
    "    done",
    "  done",
    `  if [ -n "\${HOME:-}" ] && [ -d "$HOME" ]; then ${find}; fi`,
    "}",
    "count() { each printf '%s\\0' | sort -zu | tr -cd '\\000' | wc -c | tr -d ' '; }",
    // A sort or tr that drops NUL-terminated input would count 0 and pass; check the pipeline first.
    "probe=$(printf 'x\\0x\\0y\\0' | sort -zu | tr -cd '\\000' | wc -c | tr -d ' ')",
    "found=$(count)",
    "each rm -rf --",
    "left=$(count)",
    `if [ "$probe" != 2 ]; then echo "paperclip-boat-scrub: this VM's sort/tr cannot count NUL-terminated paths; nothing verified" >&2; exit 2; fi`,
    'echo "paperclip-boat-scrub found=$found left=$left"',
    '[ "$left" = 0 ]',
  ].join("\n");
}
