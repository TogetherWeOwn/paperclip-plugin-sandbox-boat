import type { OffloadDryRunResponse } from "./protocol.js";

export interface CargoProfile {
  id: string;
  toolchains: string[];
}

export interface CargoClassification {
  mode: OffloadDryRunResponse["mode"];
  reason: string;
  profileId: string;
  subcommand: string | null;
}

const SHELL_TOKENS = new Set(["&&", "||", "|", ";", "&", ">", "<", ">>", "<<"]);
const SHELL_INLINE_RE = /[;`|]|\|\||&&|\$\(|`/;
const LLVM_COV_MODES = new Set(["test", "nextest", "run"]);

// Cargo global options the router understands (parsed, not string-split).
// Anything else before the subcommand is unrecognized and stays local.
const GLOBAL_FLAGS = new Set(["--verbose", "-v", "--quiet", "-q", "--frozen", "--locked", "--offline"]);
const GLOBAL_VALUE_FLAGS = new Set(["--color"]);
const LOCAL_HELP_VERSION = new Set(["-h", "--help", "-V", "--version", "help", "version"]);

function isCompoundShell(argv: string[]): boolean {
  return argv.some((arg) => SHELL_TOKENS.has(arg) || SHELL_INLINE_RE.test(arg));
}

function local(profile: CargoProfile, reason: string, subcommand: string | null = null): CargoClassification {
  return { mode: "local", reason, profileId: profile.id, subcommand };
}

/**
 * Classify a cargo invocation (argv without the executable).
 * Remote candidates are narrow: build/test/check/clippy/nextest run and
 * llvm-cov compilation/test modes on an installed profile toolchain.
 * Everything else — including anything unrecognized — stays local.
 */
export function classifyCargo(argv: string[], profile: CargoProfile): CargoClassification {
  if (argv.length === 0) return local(profile, "empty argv");
  if (isCompoundShell(argv)) return local(profile, "compound shell text stays local", null);

  // Only cargo-side args count: after a bare `--`, args belong to the test binary.
  const dashDash = argv.indexOf("--");
  const cargoSide = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  if (cargoSide.some((arg) => arg === "--config")) {
    return local(profile, "unrecognized --config override stays local");
  }
  if (cargoSide.some((arg) => arg === "-Z" || arg.startsWith("-Z"))) {
    return local(profile, "unstable -Z flags stay local");
  }

  let rest = [...cargoSide];
  let toolchain: string | null = null;
  if (rest[0]?.startsWith("+")) {
    toolchain = rest[0].slice(1);
    rest = rest.slice(1);
  }
  if (toolchain !== null && !profile.toolchains.includes(toolchain)) {
    return local(profile, `toolchain +${toolchain} is not installed on the profile`);
  }

  // Parse supported global options; the first non-option token is the subcommand.
  let subcommand: string | null = null;
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (LOCAL_HELP_VERSION.has(arg)) return local(profile, "help/version output stays local");
    if (GLOBAL_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return local(profile, `unrecognized global option ${arg} stays local`);
    }
    subcommand = arg;
    i += 1;
    break;
  }
  if (subcommand === null) return local(profile, "no subcommand");
  const subArgs = rest.slice(i);

  switch (subcommand) {
    case "build":
    case "test":
    case "check":
    case "clippy":
      return { mode: "remote_candidate", reason: `eligible subcommand ${subcommand}`, profileId: profile.id, subcommand };
    case "nextest":
      if (subArgs[0] === "run") {
        return { mode: "remote_candidate", reason: "eligible subcommand nextest run", profileId: profile.id, subcommand: "nextest" };
      }
      return local(profile, `nextest ${subArgs[0] ?? "(bare)"} is not a test mode`, subcommand);
    case "llvm-cov":
      if (subArgs.length === 0 || LLVM_COV_MODES.has(subArgs[0]!)) {
        return { mode: "remote_candidate", reason: "eligible llvm-cov compilation/test mode", profileId: profile.id, subcommand };
      }
      return local(profile, `llvm-cov ${subArgs[0]} is not a compilation/test mode`, subcommand);
    default:
      return local(profile, `subcommand ${subcommand} stays local`, subcommand);
  }
}
