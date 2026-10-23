// boat-offload-cargo entrypoint: a `cargo` wrapper for opted-in runs.
// Installed as `cargo` ahead of the real executable (passthrough), or invoked
// directly as `boat-offload-cargo [--dry-run] [--json] -- <cargo argv...>`
// (diagnostic). Ordinary passthrough preserves cargo's stdout, stderr and exit
// status; only staged/conflict/unknown outcomes add an explicit stderr report,
// as the stage-first contract requires.

import path from "node:path";
import { runDryRun, runOffload, type BrokerHttp, type ClientDeps, type ShimRequest } from "./client.js";
import { OFFLOAD_VERSION } from "./protocol.js";
import { classifyCargo } from "./router.js";

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
  spawn: (exe: string, argv: string[], env: Record<string, string>) => Promise<SpawnResult>;
}

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

const HELP = `boat-offload-cargo: run eligible cargo commands on a boat.dev pool VM.

Passthrough (installed as \`cargo\` on PATH for opted-in runs):
  cargo test --locked            offload when BOAT_OFFLOAD=1, else local

Diagnostic (never collides with cargo flags):
  boat-offload-cargo --dry-run -- test --locked
  boat-offload-cargo --dry-run --json -- test --locked
  boat-offload-cargo --json -- test --locked

Discovery: --dry-run classifies without a VM, sync or journal effect.
Recovery: an ambiguous submit reconciles the same command ID for 10 s, then
exits 75 with that ID; a durable never-started receipt falls back locally.
Staged remote outputs exit 74 with an artifact to apply explicitly.
`;

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

function resolveRealCargo(shimDir: string, pathEnv: string, find: ShimDeps["findExecutable"]): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir === "" || dir === shimDir) continue;
    const hit = find(dir, "cargo");
    if (hit) return hit;
  }
  return null;
}

function fallbackEnv(env: ShimDeps["env"], shimDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  out.PATH = (env.PATH ?? "").split(":").filter((dir) => dir !== "" && dir !== shimDir).join(":");
  out.BOAT_OFFLOAD_SHIM_ACTIVE = "1";
  return out;
}

function spawnExit(result: SpawnResult): number {
  if (result.code !== null && result.code !== undefined) return result.code;
  if (result.signal && SIGNAL_EXIT[result.signal] !== undefined) return SIGNAL_EXIT[result.signal]!;
  return 128;
}

export async function shimMain(scriptPath: string, args: string[], deps: ShimDeps): Promise<number> {
  const diagnostic = path.basename(scriptPath) !== "cargo";
  const shimDir = path.dirname(scriptPath);
  const writeStderr = (text: string) => deps.stderr(Buffer.from(text, "utf8"));
  const writeStdout = (text: string) => deps.stdout(Buffer.from(text, "utf8"));

  let cargoArgv: string[];
  let dryRun = false;
  let json = false;
  if (diagnostic) {
    if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
      writeStdout(HELP);
      return 0;
    }
    const dash = args.indexOf("--");
    const flags = dash >= 0 ? args.slice(0, dash) : args;
    if (dash < 0 && flags.length > 0) {
      writeStderr("usage: boat-offload-cargo [--dry-run] [--json] -- <cargo argv...>\n");
      return 64;
    }
    for (const flag of flags) {
      if (flag === "--dry-run") dryRun = true;
      else if (flag === "--json") json = true;
      else {
        writeStderr(`unknown flag ${JSON.stringify(flag)}\nusage: boat-offload-cargo [--dry-run] [--json] -- <cargo argv...>\n`);
        return 64;
      }
    }
    cargoArgv = dash >= 0 ? args.slice(dash + 1) : [];
    // Explicit diagnostic invocation bypasses BOAT_OFFLOAD, but re-entry still
    // short-circuits: a fallbacked cargo must never route back into the shim.
    if (deps.env.BOAT_OFFLOAD_SHIM_ACTIVE === "1" && !dryRun) {
      const real = resolveRealCargo(shimDir, deps.env.PATH ?? "", deps.findExecutable);
      if (!real) {
        writeStderr("boat-offload-cargo: no real cargo on PATH\n");
        return 127;
      }
      return spawnExit(await deps.spawn(real, cargoArgv, fallbackEnv(deps.env, shimDir)));
    }
  } else {
    cargoArgv = args;
  }

  const realCargo = resolveRealCargo(shimDir, deps.env.PATH ?? "", deps.findExecutable);
  if (!realCargo) {
    writeStderr("boat-offload-cargo: no real cargo on PATH\n");
    return 127;
  }
  const localEnv = fallbackEnv(deps.env, shimDir);
  const runLocal = async (argv: string[]): Promise<number> => spawnExit(await deps.spawn(realCargo, argv, localEnv));

  const workspaceId = deps.env.PAPERCLIP_WORKSPACE_ID;
  if (!diagnostic) {
    // Passthrough gating: strict opt-in, re-entry guard, workspace binding.
    if (deps.env.BOAT_OFFLOAD_SHIM_ACTIVE === "1") return runLocal(cargoArgv);
    if (deps.env.BOAT_OFFLOAD !== "1") return runLocal(cargoArgv);
    if (!workspaceId) return runLocal(cargoArgv);
  } else if (!workspaceId) {
    if (dryRun) {
      const envelope = { version: OFFLOAD_VERSION, commandId: deps.randomId(), mode: "local", reason: "no workspace binding", profileId: "" };
      writeStdout(json ? `${JSON.stringify(envelope)}\n` : "mode: local (no workspace binding)\n");
      return 0;
    }
    return runLocal(cargoArgv);
  }

  const commandId = deps.randomId();
  const clientDeps: ClientDeps = {
    http: deps.http,
    now: deps.now,
    sleep: deps.sleep,
    stdout: deps.stdout,
    stderr: deps.stderr,
    onSignal: deps.onSignal,
    randomId: () => commandId,
    runLocal,
    reportStaged: (syncBack) => {
      writeStderr(
        `offload: remote run ${syncBack.state} ${syncBack.changedPaths.length + syncBack.conflictPaths.length} path(s); ` +
          `artifact ${syncBack.artifactId ?? "(none)"}; apply explicitly with local tools, no automatic replay.\n`,
      );
    },
    reportUnknown: (info) => {
      writeStderr(`offload: execution state unknown for ${info.commandId}; exit 75, no local replay.\n`);
    },
  };
  const request: ShimRequest = {
    argv: cargoArgv,
    cwdRelative: ".",
    executionWorkspaceId: workspaceId!,
    queueTimeoutMs: parseQueueTimeoutMs(deps.env.BOAT_OFFLOAD_QUEUE_TIMEOUT_MS),
    timeoutMs: parseCommandTimeoutMs(deps.env.BOAT_OFFLOAD_TIMEOUT_MS),
    processEnv: deps.env,
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

  // Syntactic pre-filter avoids a network round trip for obviously local argv.
  let toolchains: string[];
  try {
    toolchains = deps.readToolchains();
  } catch {
    toolchains = [];
  }
  const prefilter = classifyCargo(cargoArgv, { id: "local-prefilter", toolchains });
  if (prefilter.mode === "local") {
    const exit = await runLocal(cargoArgv);
    if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId: null, mode: "local", reason: prefilter.reason, exitCode: exit })}\n`, "utf8"));
    return exit;
  }

  // Server dry-run is authoritative (profile toolchains, workload policy);
  // any dry-run failure degrades to the default local path: a dry run never
  // journals, so running local is always safe here.
  try {
    const classification = await runDryRun(request, clientDeps);
    if (classification.mode === "local") {
      const exit = await runLocal(cargoArgv);
      if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, mode: "local", reason: classification.reason, exitCode: exit })}\n`, "utf8"));
      return exit;
    }
  } catch {
    return runLocal(cargoArgv);
  }
  const exit = await runOffload(request, clientDeps);
  if (diagnostic && json) deps.stderr(Buffer.from(`${JSON.stringify({ version: OFFLOAD_VERSION, commandId, mode: "remote", exitCode: exit })}\n`, "utf8"));
  return exit;
}
