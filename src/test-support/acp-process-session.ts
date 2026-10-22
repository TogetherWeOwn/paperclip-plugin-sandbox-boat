// The Execute calls Paperclip's ACP process-session launcher makes, in the exact
// shapes of the deployed tog.22 code:
//   adapter-utils/src/execution-target.ts startAdapterExecutionTargetProcessSessionBridge
//     (~2020-2140 legacy launch, ~2460-2470 streamed launch),
//   adapter-utils/src/sandbox-callback-bridge.ts
//     syncRemoteTextFileWithHashSkip (~1669) and the command-managed
//     writeTextFile (~696-720),
//   adapter-utils/src/sandbox-shell.ts shellCommandArgs (["-c", script]).
// Every bridge step runs as `sh -c <script>` (or bash) with
// `PAPERCLIP_SANDBOX_EXEC_CHANNEL=bridge` in its env.

/** Paperclip's own shellQuote (sandbox-callback-bridge.ts ~304). */
export function paperclipShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface AcpExecCall {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

const BRIDGE_ENV = { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" };

function sh(label: string, script: string, env: Record<string, string> = BRIDGE_ENV): AcpExecCall {
  return { label, command: "sh", args: ["-c", script], env };
}

/**
 * The calls for one ACP launch whose envelope is above 64 KiB, so Paperclip
 * uploads it as `command.b64` instead of putting it in the launch command.
 * `runtimeRootDir` defaults to `<remoteCwd>/.paperclip-runtime/claude`.
 */
export function largeEnvelopeAcpLaunch(options: {
  remoteCwd?: string;
  runtimeRootDir?: string;
  sessionId?: string;
  uploadId?: string;
  base64Chunk?: string;
} = {}): AcpExecCall[] {
  const q = paperclipShellQuote;
  const remoteCwd = options.remoteCwd ?? "/home/user/paperclip-workspace";
  const root = options.runtimeRootDir ?? `${remoteCwd}/.paperclip-runtime/claude`;
  const bridgeRuntimeDir = `${root}/process-sessions`;
  const sessionDir = `${bridgeRuntimeDir}/${options.sessionId ?? "0b0f6c2e-3f2a-4f4e-9a51-6d1f4b1c2a77"}`;
  const remoteScriptPath = `${bridgeRuntimeDir}/paperclip-process-session-remote.mjs`;
  const payloadPath = `${sessionDir}/command.b64`;
  const uploadPath = `${payloadPath}.${options.uploadId ?? "5d7c1e0a-8b44-4f0e-b3a2-9c6e2f1d4b10"}.paperclip-upload`;
  const tempPath = `${uploadPath}.b64`;
  const decodedPath = `${uploadPath}.decoded`;
  // A base64 chunk of {"command":"sh","args":[...],"cwd":...,"env":{...}}.
  const chunk = options.base64Chunk ?? Buffer.from(JSON.stringify({ command: "sh", env: { PROD_DATABASE_URL: "x" } })).toString("base64");
  return [
    // First step: the wrapper-script sync into bridgeRuntimeDir.
    sh(
      "wrapper script sync",
      [
        "set -eu",
        `remote_dir=${q(bridgeRuntimeDir)}`,
        `remote_path=${q(remoteScriptPath)}`,
        `remote_partial=${q(`${remoteScriptPath}.partial`)}`,
        `remote_upload=${q(`${remoteScriptPath}.paperclip-upload.b64`)}`,
        `lock_dir=${q(`${bridgeRuntimeDir}/.paperclip-process-session-script.lock`)}`,
        `expected_sha=${q("0".repeat(64))}`,
        'mkdir -p "$remote_dir"',
        'cat > "$remote_upload"',
      ].join("\n"),
    ),
    sh("session dir mkdir", `umask 077 && mkdir -m 700 ${q(sessionDir)}`),
    sh(
      "writeTextFile prepare",
      `mkdir -p ${q(sessionDir)} && rm -f ${q(tempPath)} ${q(decodedPath)} && : > ${q(tempPath)}`,
    ),
    sh("writeTextFile chunk append", `printf '%s' ${q(chunk)} >> ${q(tempPath)}`),
    sh(
      "writeTextFile finalize",
      `base64 -d < ${q(tempPath)} > ${q(decodedPath)} && mv ${q(decodedPath)} ${q(payloadPath)} && rm -f ${q(tempPath)}`,
    ),
    sh("payload chmod", `chmod 600 ${q(payloadPath)}`),
    // Legacy (polled) launch: no envelope string in it at all.
    sh(
      "legacy launch",
      [
        `mkdir -p ${q(`${sessionDir}/stdin`)} ${q(`${sessionDir}/events`)}`,
        `PAPERCLIP_PROCESS_SESSION_DIR=${q(sessionDir)} nohup node ${q(remoteScriptPath)} >/dev/null 2>&1 < /dev/null &`,
      ].join("\n"),
    ),
    // Streamed launch: the session dir rides the env.
    sh("streamed launch", `node ${q(`${bridgeRuntimeDir}/paperclip-process-session-remote-stream.mjs`)}`, {
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
    }),
    sh("teardown remove", `rm -rf ${q(sessionDir)}`),
  ];
}

/** Paperclip commands a cli-engine run makes on a boat VM; none is ACP. */
export function cliEngineCalls(remoteCwd = "/home/user/paperclip-workspace"): AcpExecCall[] {
  const q = paperclipShellQuote;
  const queueDir = `${remoteCwd}/.paperclip-runtime/claude/queue`;
  return [
    sh("workspace mkdir", `mkdir -p ${q(remoteCwd)}`),
    sh("callback bridge queue mkdir", `mkdir -p ${q(`${queueDir}/requests`)} ${q(`${queueDir}/responses`)}`),
    sh("callback bridge response write", `printf '%s' ${q("eyJvayI6dHJ1ZX0=")} >> ${q(`${queueDir}/responses/r1.json.u1.paperclip-upload.b64`)}`),
    { label: "claude cli", command: "claude", args: ["--print", "-", "--output-format", "stream-json", "--verbose"], env: {} },
    { label: "git status", command: "git", args: ["-C", remoteCwd, "status", "--porcelain"], env: {} },
  ];
}
