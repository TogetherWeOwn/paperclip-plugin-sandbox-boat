// Shim entrypoint: a package-runner wrapper for opted-in runs.
// Installed as the wrapped executable ahead of the real one (passthrough), or
// invoked directly as a diagnostic binary ([--dry-run] [--json]
// [--runner <name>] -- <argv...>) (diagnostic). Ordinary passthrough preserves
// stdout, stderr and exit status; staged/conflict/unknown outcomes add an
// explicit stderr report, as the stage-first contract requires, and so does
// every local fallback of a command classified as a remote candidate: a
// silent fallback reads exactly like a successful remote run.

import path from "node:path";
import { reportDuration, runDryRun, runOffload, type BrokerHttp, type ClientDeps, type ShimRequest } from "./client.js";
import { OFFLOAD_VERSION } from "./protocol.js";
import { classifyCargo, classifyNode, classifyPython } from "./router.js";

export interface SpawnResult {
  code: number | null;
  signal: string | null;
}

export interface ShimDeps {
  env: Record<string, string | undefined>;
  http: BrokerHttp;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (bytes: Uint8Array) => void;
  stderr: (bytes: Uint8Array) => void;
  onSignal: (handler: (signal: "SIGINT" | "SIGTERM") => void) => void;
  randomId: () => string;
  findExecutable: (dir: string, name: string) => string | null;
  readToolchains: () => string[];
  /** Optional: resolve symlinks so a candidate that is the shim itself is never used as the real executable. */
  realpath?: (p: string) => string;
  /** The shim process's working directory. */
  cwd: () => string;
  /** Strict realpath for the workspace/cwd check: null when the path cannot be resolved. */
  canonicalDir: (p: string) => string | null;
  /** `onSpawn` hands the caller a way to signal the child so termination is forwarded, not dropped. */
  spawn: (exe: string, argv: string[], env: Record<string, string>, options?: SpawnOptions) => Promise<SpawnResult>;
}

export interface SpawnOptions {
  onSpawn?: (kill: (signal: "SIGINT" | "SIGTERM") => void) => void;
}

export interface ToolShim {
  tool: "cargo" | "node" | "python";
  /** Basenames the shim answers to: passthrough when installed as one of these, diagnostic otherwise. */
  exeNames: string[];
  /** Diagnostic binary name, for help and error text. */
  diagnosticName: string;
  defaultRunner: string;
  classify(runner: string, argv: string[], toolchains: string[]): { mode: "local" | "remote_candidate"; reason: string };
}

export const CARGO_SHIM: ToolShim = {
  tool: "cargo",
  exeNames: ["cargo"],
  diagnosticName: "boat-offload-cargo",
  defaultRunner: "cargo",
  classify: (_runner, argv, toolchains) => classifyCargo(argv, { id: "local-prefilter", toolchains }),
};

export const NODE_SHIM: ToolShim = {
  tool: "node",
  exeNames: ["npm", "pnpm", "yarn", "npx"],
  diagnosticName: "boat-offload-node",
  defaultRunner: "npm",
  classify: (runner, argv) => classifyNode(runner, argv, { id: "local-prefilter" }),
};

export const PYTHON_SHIM: ToolShim = {
  tool: "python",
  exeNames: ["pytest", "python", "python3"],
  diagnosticName: "boat-offload-python",
  defaultRunner: "pytest",
  classify: (runner, argv) => classifyPython(runner, argv, { id: "local-prefilter" }),
};

const SIGNAL_EXIT: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGILL: 132,
  SIGTRAP: 133,
  SIGABRT: 134,
  SIGBUS: 135,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGSEGV: 139,
  SIGPIPE: 141,
  SIGALRM: 142,
  SIGTERM: 143,
};

function helpFor(tool: ToolShim): string {
  const [first, ...rest] = tool.exeNames;
  const example = tool.tool === "cargo" ? "test --locked" : tool.tool === "node" ? "run test" : "tests/";
  return `${tool.diagnosticName}: run eligible ${tool.tool} commands on a boat.dev pool VM.

Passthrough (installed as \`${first}${rest.length > 0 ? `|${rest.join("|")}` : ""}\` on PATH for opted-in runs):
  ${first} ${example}            offload when BOAT_OFFLOAD=1, else local

Diagnostic (never collides with ${tool.tool} flags):
  ${tool.diagnosticName} --dry-run -- ${example}
  ${tool.diagnosticName} --dry-run --json -- ${example}
  ${tool.diagnosticName} --json -- ${example}
${tool.tool === "python" ? "\nExplicit locked uv test extra (never inferred from pytest):\n  BOAT_OFFLOAD_UV_EXTRA=test pytest tests/\n  boat-offload-python --uv-extra test --dry-run -- tests/\n" : ""}
Discovery: --dry-run classifies without a VM, sync or journal effect.
Recovery: an ambiguous submit reconciles the same command ID for 10 s, then
exits 75 with that ID; a durable never-started receipt falls back locally.
Staged remote outputs exit 74 with an artifact to apply explicitly.
`;
}

function parseQueueTimeoutMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) return 30_000;
  return Math.min(n, 30_000);
}

function parseCommandTimeoutMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1000) return 1_200_000;
  return Math.min(n, 1_800_000);
}

/** Spelling-insensitive directory key: trailing/double slashes and `.` segments collapse. */
function dirKey(dir: string): string {
  return path.resolve(dir);
}

function resolveRealExe(shimDir: string, scriptPath: string, pathEnv: string, exeName: string, deps: Pick<ShimDeps, "findExecutable" | "realpath">): string | null {
  const real = deps.realpath ?? ((p: string) => p);
  const shimKey = dirKey(shimDir);
  const selfKey = real(path.resolve(scriptPath));
  for (const dir of pathEnv.split(":")) {
    if (dir === "" || dirKey(dir) === shimKey) continue;
    const hit = deps.findExecutable(dir, exeName);
    if (!hit) continue;
    // A symlinked spelling of the shim dir (or a link to the shim) must not
    // become its own fallback target.
    if (real(path.resolve(hit)) === selfKey) continue;
    return hit;
  }
  return null;
}

/** The caller's cwd relative to the workspace root (posix), or why it cannot be offloaded. */
function workspaceRelativeCwd(deps: Pick<ShimDeps, "env" | "cwd" | "canonicalDir">): { cwd: string } | { reason: string } {
  const rootEnv = deps.env.PAPERCLIP_WORKSPACE_CWD;
  const root = rootEnv ? deps.canonicalDir(rootEnv) : null;
  if (!root) return { reason: "no workspace root" };
  const here = deps.canonicalDir(deps.cwd());
  if (!here) return { reason: "cwd unresolvable" };
  const rel = path.relative(root, here);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return { reason: "cwd outside workspace" };
  return { cwd: rel === "" ? "." : rel.split(path.sep).join("/") };
}

function fallbackEnv(env: ShimDeps["env"], shimDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  const shimKey = dirKey(shimDir);
  out.PATH = (env.PATH ?? "").split(":").filter((dir) => dir !== "" && dirKey(dir) !== shimKey).join(":");
  out.BOAT_OFFLOAD_SHIM_ACTIVE = "1";
  return out;
}

/** Server-supplied reasons are printed on one stderr line; never let one forge extra lines. */
function oneLine(reason: string): string {
  return reason.replace(/[\r\n]+/g, " ").slice(0, 256);
}

function spawnExit(result: SpawnResult): number {
  if (result.code !== null && result.code !== undefined) return result.code;
  if (result.signal && SIGNAL_EXIT[result.signal] !== undefined) return SIGNAL_EXIT[result.signal]!;
  return 128;
}

const PINNED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function shimMain(scriptPath: string, args: string[], deps: ShimDeps, tool: ToolShim = CARGO_SHIM): Promise<number> {
  // Optional operator-preselected command ID: a consistency selector, never
  // authority. Validated before any spawn or network call.
  const rawPinned = deps.env.BOAT_OFFLOAD_COMMAND_ID;
  let pinnedId: string | null = null;
  if (rawPinned !== undefined) {
    if (!PINNED_ID_RE.test(rawPinned)) {
      deps.stderr(Buffer.from(`${tool.diagnosticName}: BOAT_OFFLOAD_COMMAND_ID must be a canonical UUID; exit 64, nothing run.\n`, "utf8"));
      return 64;
    }
    pinnedId = rawPinned.toLowerCase();
  }
  let uvExtra = deps.env.BOAT_OFFLOAD_UV_EXTRA;
  const installedAs = path.basename(scriptPath);
  const diagnostic = !tool.exeNames.includes(installedAs);
  const diag = tool.diagnosticName;
  const shimDir = path.dirname(scriptPath);
  const writeStderr = (text: string) => deps.stderr(Buffer.from(text, "utf8"));
  const writeStdout = (text: string) => deps.stdout(Buffer.from(text, "utf8"));
  const idOrRandom = (): string => pinnedId ?? deps.randomId();
  /** Pinned real mode never runs locally: stop with a clear reason and exit 75. */
  const refusePinned = (reason: string): number => {
    writeStderr(`${diag}: pinned command ${pinnedId}; local run refused (${oneLine(reason)}); exit 75, nothing run locally.\n`);
    return 75;
  };

  let toolArgv: string[];
  let dryRun = false;
  let json = false;
  let runner = diagnostic ? tool.defaultRunner : installedAs;
  if (diagnostic) {
    if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
      writeStdout(helpFor(tool));
      return 0;
    }
    const dash = args.indexOf("--");
    const flags = dash >= 0 ? args.slice(0, dash) : args;
    if (dash < 0 && flags.length > 0) {
      writeStderr(`usage: ${diag} [--dry-run] [--json] [--runner <name>] -- <argv...>\n`);
      return 64;
    }
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (flag === "--dry-run") dryRun = true;
      else if (flag === "--json") json = true;
      else if (flag === "--uv-extra") {
        const extra = flags[++i];
        if (tool.tool !== "python" || extra !== "test") {
          writeStderr(`${diag}: --uv-extra supports only test for python; exit 64, nothing run.\n`);
          return 64;
        }
        uvExtra = extra;
      } else if (flag === "--runner") {
        const name = flags[i + 1];
        i += 1;
        if (!name || !tool.exeNames.includes(name)) {
          writeStderr(`unknown runner ${JSON.stringify(name ?? "")}\nusage: ${diag} [--dry-run] [--json] [--runner <name>] -- <argv...>\n`);
          return 64;
        }
        runner = name;
      } else {
        writeStderr(`unknown flag ${JSON.stringify(flag)}\nusage: ${diag} [--dry-run] [--json] [--runner <name>] -- <argv...>\n`);
        return 64;
      }
    }
    toolArgv = dash >= 0 ? args.slice(dash + 1) : [];
  } else {
    toolArgv = args;
  }

  const pinnedReal = pinnedId !== null && !(diagnostic && dryRun);
  const realExe = pinnedReal ? null : resolveRealExe(shimDir, scriptPath, deps.env.PATH ?? "", diagnostic ? runner : installedAs, deps);
  if (!realExe && !pinnedReal) {
    writeStderr(`${diag}: no real ${diagnostic ? runner : installedAs} on PATH\n`);
    return 127;
  }
  const localEnv = fallbackEnv(deps.env, shimDir);
  // A pid-directed SIGINT/SIGTERM must reach the local child and end the shim
  // with 128+N; recording it for later would let the build finish and exit 0.
  let pendingSignal: "SIGINT" | "SIGTERM" | null = null;
  let killChild: ((signal: "SIGINT" | "SIGTERM") => void) | null = null;
  deps.onSignal((signal) => {
    pendingSignal ??= signal;
    killChild?.(signal);
  });
  const spawnLocal = async (exe: string, argv: string[], env: Record<string, string>): Promise<number> => {
    const result = await deps.spawn(exe, argv, env, {
      onSpawn: (kill) => {
        killChild = kill;
        if (pendingSignal) kill(pendingSignal);
      },
    });
    killChild = null;
    if (pendingSignal) return SIGNAL_EXIT[pendingSignal]!;
    return spawnExit(result);
  };
  const runLocal = async (argv: string[]): Promise<number> => {
    if (pinnedReal || !realExe) return refusePinned("local run");
    return spawnLocal(realExe, argv, localEnv);
  };

  // Diagnostic execution bypasses BOAT_OFFLOAD, but both entry modes must
  // short-circuit re-entry through the signal-aware local path. Dry-run still
  // performs discovery without spawning.
  if (deps.env.BOAT_OFFLOAD_SHIM_ACTIVE === "1" && !dryRun) return pinnedReal ? refusePinned("shim re-entry") : runLocal(toolArgv);

  const workspaceId = deps.env.PAPERCLIP_WORKSPACE_ID;
  if (!diagnostic) {
    // Passthrough gating: strict opt-in, workspace binding.
    if (deps.env.BOAT_OFFLOAD !== "1") return pinnedReal ? refusePinned("BOAT_OFFLOAD is not 1") : runLocal(toolArgv);
    if (!workspaceId) return pinnedReal ? refusePinned("no workspace binding") : runLocal(toolArgv);
  } else if (!workspaceId) {
    if (dryRun) {
      const envelope = { version: OFFLOAD_VERSION, commandId: idOrRandom(), mode: "local", reason: "no workspace binding", profileId: "" };
      writeStdout(json ? `${JSON.stringify(envelope)}\n` : "mode: local (no workspace binding)\n");
      return 0;
    }
    return pinnedReal ? refusePinned("no workspace binding") : runLocal(toolArgv);
  }
  // Remote runs execute in the same workspace-relative directory as the caller;
  // a cwd outside the workspace (or no resolvable root) stays local.
  const located = workspaceRelativeCwd(deps);
  if ("reason" in located) {
    if (diagnostic && dryRun) {
      const envelope = { version: OFFLOAD_VERSION, commandId: idOrRandom(), mode: "local", reason: located.reason, profileId: "" };
      writeStdout(json ? `${JSON.stringify(envelope)}\n` : `mode: local (${located.reason})\n`);
      return 0;
    }
    return pinnedReal ? refusePinned(located.reason) : runLocal(toolArgv);
  }

  // Validate only after local passthrough/re-entry/workspace gates. An inherited
  // opt-in must not break local children. It is never forwarded as guest env.
  if (uvExtra !== undefined && (tool.tool !== "python" || uvExtra !== "test")) {
    writeStderr(`${diag}: BOAT_OFFLOAD_UV_EXTRA supports only test for python; exit 64, nothing run.\n`);
    return 64;
  }
  const commandId = idOrRandom();
  const request: ShimRequest = {
    tool: tool.tool,
    runner,
    argv: toolArgv,
    cwdRelative: located.cwd,
    ...(uvExtra === undefined ? {} : { depSelection: { uvExtra: "test", cwdRelative: located.cwd } }),
    executionWorkspaceId: workspaceId!,
    queueTimeoutMs: parseQueueTimeoutMs(deps.env.BOAT_OFFLOAD_QUEUE_TIMEOUT_MS),
    timeoutMs: parseCommandTimeoutMs(deps.env.BOAT_OFFLOAD_TIMEOUT_MS),
    processEnv: deps.env,
    ...(pinnedReal ? { allowLocalFallback: false } : {}),
  };
  const clientDeps: ClientDeps = {
    http: deps.http,
    now: deps.now,
    sleep: deps.sleep,
    stdout: deps.stdout,
    stderr: deps.stderr,
    onSignal: deps.onSignal,
    randomId: () => commandId,
    runLocal: (argv) => (pinnedReal ? Promise.resolve(refusePinned("local run")) : runLocalMeasured(argv)),
    reportStaged: (syncBack) => {
      writeStderr(
        `offload: remote run ${syncBack.state} ${syncBack.changedPaths.length + syncBack.conflictPaths.length} path(s); ` +
          `artifact ${syncBack.artifactId ?? "(none)"}; apply explicitly with local tools, no automatic replay.\n`,
      );
    },
    reportUnknown: (info) => {
      writeStderr(`offload: execution state unknown for ${info.commandId}; exit 75, no local replay.\n`);
    },
    reportFallback: (info) => {
      writeStderr(`offload: running local (${oneLine(info.reason)})\n`);
    },
  };
  // A remote-candidate command that ends up running locally teaches the
  // server duration gate. Cargo never reports; pre-opt-in runs never report.
  const runLocalMeasured = async (argv: string[]): Promise<number> => {
    if (tool.tool === "cargo") return runLocal(argv);
    const startedAt = deps.now();
    try {
      return await runLocal(argv);
    } finally {
      const seconds = Math.max(0, (deps.now() - startedAt) / 1000);
      await reportDuration(request, clientDeps, seconds);
    }
  };

  if (diagnostic && dryRun) {
    // Discovery consults the server profile even for locally-routable argv.
    try {
      const result = await runDryRun(request, clientDeps);
      if (json) writeStdout(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, ...result })}\n`);
      else writeStdout(`mode: ${result.mode} (${result.reason}) profile: ${result.profileId || "(none)"}\n`);
      return 0;
    } catch (error) {
      writeStderr(`offload dry-run failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 64;
    }
  }

  // Pinned real mode goes straight to the authoritative path: a prefilter or
  // dry-run could hide an existing receipt behind a local decision.
  if (pinnedReal) {
    const pinnedExit = await runOffload(request, clientDeps);
    if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, mode: "remote", exitCode: pinnedExit })}\n`, "utf8"));
    return pinnedExit;
  }

  // Syntactic pre-filter avoids a network round trip for obviously local argv.
  let toolchains: string[];
  try {
    toolchains = tool.tool === "cargo" ? deps.readToolchains() : [];
  } catch {
    toolchains = [];
  }
  const prefilter = tool.classify(runner, toolArgv, toolchains);
  if (prefilter.mode === "local") {
    const exit = await runLocal(toolArgv);
    if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId: null, mode: "local", reason: prefilter.reason, exitCode: exit })}\n`, "utf8"));
    return exit;
  }

  // Server dry-run is authoritative (profile toolchains, workload policy);
  // any dry-run failure degrades to the default local path: a dry run never
  // journals, so running local is always safe here. The prefilter already
  // called this argv a remote candidate, so either local path is announced:
  // an unannounced fallback is indistinguishable from a remote run. Only the
  // dry-run call is inside the catch: a rejecting local spawn must surface
  // once, never be mistaken for a dry-run failure and run a second time.
  let classification: Awaited<ReturnType<typeof runDryRun>>;
  try {
    classification = await runDryRun(request, clientDeps);
  } catch (error) {
    writeStderr(`offload: running local (dry-run failed: ${oneLine(error instanceof Error ? error.message : String(error))})\n`);
    return runLocalMeasured(toolArgv);
  }
  if (classification.mode === "local") {
    writeStderr(`offload: running local (${oneLine(classification.reason)})\n`);
    const exit = await runLocalMeasured(toolArgv);
    if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, mode: "local", reason: classification.reason, exitCode: exit })}\n`, "utf8"));
    return exit;
  }
  const exit = await runOffload(request, clientDeps);
  if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, mode: "remote", exitCode: exit })}\n`, "utf8"));
  return exit;
}
