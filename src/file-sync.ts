import path from "node:path";
import { PassThrough } from "node:stream";
import type { PluginEnvironmentSyncResult, PluginSyncFileMapping, PluginSyncOperation } from "@paperclipai/plugin-sdk";
import { FILE_SYNC_SCRIPT } from "./file-sync-script.js";
import { buildRemoteCommand, shellQuote } from "./shell.js";
import { runStreamProcess } from "./ssh.js";
import type { SshExecutionResult, SshManager, SshSession } from "./ssh.js";

interface SyncContext {
  ssh: SshManager;
  session: SshSession;
  timeoutMs: number;
  remoteRoot: string;
}

type Counts = { filesTransferred: number; bytesTransferred: number };

function absolute(value: string): string {
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").slice(1).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Native sync requires canonical absolute paths below the filesystem root.");
  }
  return value;
}

function check(result: SshExecutionResult): SshExecutionResult {
  if (result.timedOut || result.signal || result.exitCode !== 0) {
    // Output can contain file contents/credentials. Do not echo it into logs.
    throw new Error(`Native sync process failed (exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}).`);
  }
  return result;
}

async function transfer(context: SyncContext, direction: "in" | "out", file: PluginSyncFileMapping): Promise<Counts> {
  absolute(file.sourcePath);
  absolute(file.targetPath);
  const mapping = JSON.stringify(file);
  if (Buffer.byteLength(mapping) > 64 * 1024) throw new Error("Native sync mapping exceeds metadata limit.");
  const localAction = direction === "in" ? "send" : "receive";
  const remoteAction = direction === "in" ? "receive" : "send";
  const pipe = new PassThrough({ highWaterMark: 64 * 1024 });
  const local = runStreamProcess("python3", ["-c", FILE_SYNC_SCRIPT, localAction, mapping], {
    timeoutMs: context.timeoutMs,
    ...(direction === "in" ? { stdout: pipe } : { stdin: pipe }),
  });
  const command = buildRemoteCommand(`exec python3 -c ${shellQuote(FILE_SYNC_SCRIPT)} ${remoteAction} ${shellQuote(mapping)}`);
  const remote = context.ssh.runStream(context.session, command, {
    timeoutMs: context.timeoutMs,
    ...(direction === "in" ? { stdin: pipe } : { stdout: pipe }),
  });
  // Either failed endpoint cancels its peer. Await both so a rejected hook never
  // leaves a local producer or an SSH channel running in the background.
  for (const pending of [local, remote]) void pending.catch((error: Error) => pipe.destroy(error));
  const results = await Promise.allSettled([local, remote]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    check(result.value);
  }
  const receiver = results[direction === "in" ? 1 : 0] as PromiseFulfilledResult<SshExecutionResult>;
  const counts = JSON.parse(receiver.value.stdout) as Counts;
  if (![counts.filesTransferred, counts.bytesTransferred].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("Native sync returned invalid transfer accounting.");
  }
  return counts;
}

// The control string is passed unchanged as sh's one argument, never spliced
// into a provider shell script. Open cwd component-by-component before exec.
const POST_UPLOAD_SCRIPT = String.raw`
import os, sys
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in sys.argv[1].split('/')[1:]:
        nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = nxt
    os.fchdir(fd)
finally:
    os.close(fd)
os.execv('/bin/sh', ['sh', '-c', sys.argv[2]])
`;

async function postUpload(context: SyncContext, operation: PluginSyncOperation): Promise<void> {
  const root = absolute(context.remoteRoot);
  const roots = [root, ...operation.files.map((f) => f.kind === "directory" ? f.targetPath : path.posix.dirname(f.targetPath))];
  for (const control of operation.postUploadCommands ?? []) {
    const cwd = absolute(control.cwd ?? root);
    if (!roots.some((allowed) => allowed !== "/" && (cwd === allowed || cwd.startsWith(`${allowed}/`)))) {
      throw new Error("Post-upload cwd escapes the operation's sandbox target roots.");
    }
    const timeoutMs = control.timeoutMs ?? context.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid post-upload timeout.");
    check(await context.ssh.runStream(context.session,
      buildRemoteCommand(`exec python3 -c ${shellQuote(POST_UPLOAD_SCRIPT)} ${shellQuote(cwd)} ${shellQuote(control.command)}`),
      { timeoutMs: Math.min(timeoutMs, context.timeoutMs) }));
  }
}

export async function syncFiles(context: SyncContext, direction: "in" | "out", operations: PluginSyncOperation[]): Promise<PluginEnvironmentSyncResult> {
  const results: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of operations) {
    if (direction === "out" && operation.postUploadCommands?.length) {
      throw new Error("Post-upload commands are supported only for inbound sync.");
    }
    const counts: Counts = { filesTransferred: 0, bytesTransferred: 0 };
    for (const file of operation.files) {
      const moved = await transfer(context, direction, file);
      counts.filesTransferred += moved.filesTransferred;
      counts.bytesTransferred += moved.bytesTransferred;
    }
    if (direction === "in" && operation.postUploadCommands?.length) await postUpload(context, operation);
    results.push({ operationId: operation.operationId, ...counts });
  }
  return { operations: results };
}
