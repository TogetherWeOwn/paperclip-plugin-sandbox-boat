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
//     the payload never sees it on disk. A trailing remove after the payload
//     stays as a fallback for a script that did not get that far.
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
// credentials, and only then runs the payload. The trailing remove is a
// fallback for a script that stopped before the first one (a failed `cd` or a
// failed source). The payload must not end in a terminal `exec`, which would
// skip the trailing remove.
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
    lines.push(UNSET_BOAT_VM_CREDENTIALS, `exec ${commandParts}`);
  }
  return lines.join(" && ");
}
