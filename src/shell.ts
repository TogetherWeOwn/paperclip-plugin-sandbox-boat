// Shell helpers carried over from the exe-dev provider (Paperclip
// packages/plugins/sandbox-providers/exe-dev). The env-file staging rules are
// the same: env values never ride argv; they travel over the encrypted ssh
// stdin pipe into a remote 0600 file that the payload script sources and then
// removes in the same shell invocation.
import { randomUUID } from "node:crypto";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function filterStringEnvEntries(env: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
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

export function remoteEnvFileName(): string {
  return `.paperclip-boat-env-${randomUUID().replace(/-/g, "")}.sh`;
}

// Sources the staged env file, then runs the payload with a chained `rm -f`
// so the secret-bearing file is removed on success and on failure. The payload
// must not end in a terminal `exec`, which would skip the chained `rm`.
export function envSourcingScriptLines(remotePath: string, payloadScript: string): string[] {
  const quoted = shellQuote(remotePath);
  return [`if [ -f ${quoted} ]; then . ${quoted}; fi`, `${payloadScript}; rc=$?; rm -f ${quoted}; exit $rc`];
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  remoteEnvPath?: string | null;
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
  if (input.remoteEnvPath != null) {
    lines.push(...envSourcingScriptLines(input.remoteEnvPath, commandParts));
  } else {
    lines.push(`exec ${commandParts}`);
  }
  return lines.join(" && ");
}
