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
  /** Package runner or test binary that produced the classification (node/python only). */
  runner?: string;
}

export interface ToolProfile {
  id: string;
}

const SHELL_TOKENS = new Set(["&&", "||", "|", ";", "&", ">", "<", ">>", "<<"]);
const SHELL_INLINE_RE = /[;`|]|\|\||&&|\$\(|`/;
const LLVM_COV_MODES = new Set(["test", "nextest", "run"]);

// Cargo global options the router understands (parsed, not string-split).
// Anything else before the subcommand is unrecognized and stays local.
const GLOBAL_FLAGS = new Set(["--verbose", "-v", "--quiet", "-q", "--frozen", "--locked", "--offline"]);
const GLOBAL_VALUE_FLAGS = new Set(["--color"]);
const CARGO_PATH_FLAG_RE = /^(--(manifest-path|target-dir|out-dir|artifact-dir|lockfile-path)|-C)(=|$)/;
const LOCAL_HELP_VERSION = new Set(["-h", "--help", "-V", "--version", "help", "version"]);

function isCompoundShell(argv: string[]): boolean {
  return argv.some((arg) => SHELL_TOKENS.has(arg) || SHELL_INLINE_RE.test(arg));
}

/** Cargo-side argv: everything before a bare `--` belongs to Cargo. Args after
 * it belong to the test binary and must never change the host's stay-local or
 * cache-priming decisions. */
export function cargoSideArgv(argv: string[]): string[] {
  const dashDash = argv.indexOf("--");
  return dashDash >= 0 ? argv.slice(0, dashDash) : argv;
}

/** Whether this invocation asks Cargo itself for offline mode. */
export function isCargoOffline(argv: string[]): boolean {
  return cargoSideArgv(argv).includes("--offline");
}

/** A validated leading rustup toolchain selector (`+stable`), or null. */
export function cargoToolchain(argv: string[], toolchains: readonly string[]): string | null {
  const first = cargoSideArgv(argv)[0];
  if (!first?.startsWith("+") || first.length < 2) return null;
  return toolchains.includes(first.slice(1)) ? first : null;
}

function local(profile: { id: string }, reason: string, subcommand: string | null = null, runner?: string): CargoClassification {
  return { mode: "local", reason, profileId: profile.id, subcommand, ...(runner === undefined ? {} : { runner }) };
}

function remote(profile: { id: string }, reason: string, subcommand: string | null, runner: string): CargoClassification {
  return { mode: "remote_candidate", reason, profileId: profile.id, subcommand, runner };
}

// ---------------------------------------------------------------------------
// Node: npm|pnpm|yarn run/test of a test/e2e/build script, or a test-binary
// invocation through npx|pnpm exec (vitest run, jest, playwright test,
// next build). Everything else stays local: watch modes, single-file filters,
// lint/typecheck/format, install/ci, dev servers and unrecognized shapes.

const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const NODE_BIN_RUNNERS = new Set(["npx", "pnpm", "yarn", "npm"]);
const NODE_TEST_SCRIPT_RE = /^(test|tests|e2e|integration|spec|specs|build)([:\-]|$)/i;
/** Watch-mode npm scripts never go remote: a killed watch burns VM-hours. */
const NODE_WATCH_SCRIPT_RE = /:watch|watch$/i;
/** Deploy/publish/release-like script names never go remote. */
const NODE_PUBLISH_DENY_RE = /deploy|publish|release|push|upload|prod|ship/i;
/** Conservative build sub-suffix allowlist: exact `build` plus these only. */
const NODE_BUILD_SUFFIX_ALLOW = new Set([
  "test", "tests", "e2e", "integration", "spec", "specs", "ci",
  "client", "server", "web", "app", "static", "bundle",
]);

/** True for exact `build` or a `build:<suffix>`/`build-<suffix>` name. */
function isBuildScript(script: string): boolean {
  const lower = script.toLowerCase();
  return lower === "build" || lower.startsWith("build:") || lower.startsWith("build-");
}

/** True only for exact `build` or an allowlisted suffix without deny words. */
function isAllowedBuildScript(script: string): boolean {
  if (script.toLowerCase() === "build") return true;
  const suffix = /^build[:\-](.+)$/i.exec(script)?.[1];
  if (!suffix) return false;
  if (NODE_PUBLISH_DENY_RE.test(script)) return false;
  return NODE_BUILD_SUFFIX_ALLOW.has(suffix.toLowerCase());
}
/** Flags that narrow a run to interactive or single-test scope. */
const NODE_WATCH_FLAGS = new Set(["--watch", "--watchAll", "--watch-all", "--ui", "--open", "--inspect", "--inspect-brk"]);
const NODE_NARROW_FLAGS = new Set(["-t", "--testNamePattern", "--testPathPattern", "--grep", "-g"]);
/** Node flags that take a separate value: skip the value when scanning positionals. */
const NODE_VALUE_FLAGS = new Set([
  "-t", "--testNamePattern", "--testPathPattern", "--grep", "-g",
  "--config", "--outputFile", "--output-file", "--cacheDirectory", "--cache-directory",
  "--rootDir", "--rootdir", "--reporters",
]);
const NODE_LOCAL_COMMANDS = new Set([
  "install", "ci", "add", "remove", "link", "publish", "login", "init",
  "dev", "start", "serve", "preview", "lint", "format", "typecheck", "clean",
  "dedupe", "audit", "outdated", "ls", "list", "why", "version", "help",
]);

/** A positional that selects specific tests rather than a whole suite. */
function isNodeTestSelection(arg: string): boolean {
  if (arg.includes("::")) return true;
  if (/(^|[./])([^/]*\.(test|spec)\.[a-z0-9]+)$/i.test(arg)) return true;
  // A file path with an extension is a single-file filter, not a suite dir.
  if (arg.includes("/") && /\.[a-z0-9]+$/i.test(arg)) return true;
  // A bare name filter (e.g. `jest login`): slash-free, not a suite dir.
  if (!arg.includes("/") && arg !== "." && !arg.startsWith("-")
    && !["test", "run", "build"].includes(arg) && /^[A-Za-z0-9_@#.+-]+$/.test(arg)) return true;
  return false;
}

/** A positional that names a whole suite directory rather than a file. */
function isNodeSuiteDir(arg: string): boolean {
  if (arg.startsWith("-") || arg.includes("::")) return false;
  // Files (any extension) are filters, never suite dirs. Only bare dirs count.
  if (/\.[a-z0-9]+$/i.test(arg)) return false;
  return arg.includes("/") || arg === ".";
}

function nodeWatchOnly(argv: string[], _binary: string | null): string | null {
  for (const arg of argv) {
    if (NODE_WATCH_FLAGS.has(arg)) return `watch/interactive flag ${arg} stays local`;
    if (arg === "-w") return "watch flag -w stays local";
  }
  return null;
}

function nodeNarrowed(argv: string[]): string | null {
  for (const arg of argv) {
    if (NODE_NARROW_FLAGS.has(arg)) return `narrowing flag ${arg} stays local without an explicit suite`;
  }
  return null;
}

function nodeWatchOrNarrow(argv: string[], binary: string | null, suiteDir: boolean): string | null {
  const watch = nodeWatchOnly(argv, binary);
  if (watch) return watch;
  // A narrowing flag with an explicit suite directory still runs whole-suite.
  if (!suiteDir) return nodeNarrowed(argv);
  return null;
}

function nodePositionals(argv: string[]): { selection: string | null; suiteDir: boolean } {
  let selection: string | null = null;
  let suiteDir = false;
  let seenDashDash = false;
  let skipNext = false;
  for (const arg of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (!seenDashDash && NODE_VALUE_FLAGS.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-") && !seenDashDash) continue;
    if (!seenDashDash && arg.includes("=")) continue;
    if (isNodeTestSelection(arg)) selection = arg;
    else if (!arg.startsWith("-") && isNodeSuiteDir(arg)) suiteDir = true;
  }
  return { selection, suiteDir };
}

function classifyNodeBinary(binary: string, args: string[], profile: ToolProfile, runner: string): CargoClassification {
  const { selection, suiteDir } = nodePositionals(args);
  const narrowed = nodeWatchOrNarrow(args, binary, suiteDir);
  if (narrowed) return local(profile, narrowed, binary, runner);
  if (binary === "vitest") {
    if (args[0] !== "run") return local(profile, "vitest without run is watch mode and stays local", binary, runner);
    if (selection && !suiteDir) return local(profile, `single-file filter ${selection} stays local`, binary, runner);
    return remote(profile, "eligible vitest run", binary, runner);
  }
  if (binary === "jest") {
    if (selection && !suiteDir) return local(profile, `single-file filter ${selection} stays local`, binary, runner);
    return remote(profile, "eligible jest run", binary, runner);
  }
  if (binary === "playwright") {
    if (args[0] !== "test") return local(profile, `playwright ${args[0] ?? "(bare)"} is not a test run`, binary, runner);
    if (selection && !suiteDir) return local(profile, `single-file filter ${selection} stays local`, binary, runner);
    return remote(profile, "eligible playwright test", binary, runner);
  }
  if (binary === "next") {
    if (args[0] !== "build") return local(profile, `next ${args[0] ?? "(bare)"} is not a build`, binary, runner);
    return remote(profile, "eligible next build", binary, runner);
  }
  return local(profile, `unrecognized test binary ${binary} stays local`, binary, runner);
}

/**
 * Classify a Node invocation: package-manager runner plus argv without the
 * executable. Remote candidates are narrow: run/test of a test/e2e/build
 * script, or a vitest/jest/playwright/next invocation. Watch modes,
 * single-file filters, lint/typecheck/format, install/ci, dev servers and
 * anything unrecognized stay local.
 */
export function classifyNode(runner: string, argv: string[], profile: ToolProfile): CargoClassification {
  if (argv.length === 0) return local(profile, "empty argv", null, runner);
  if (isCompoundShell(argv)) return local(profile, "compound shell text stays local", null, runner);
  if (!NODE_MANAGERS.has(runner) && !NODE_BIN_RUNNERS.has(runner)) {
    return local(profile, `unrecognized node runner ${runner} stays local`, null, runner);
  }
  const [command, ...rest] = argv as [string, ...string[]];
  // `pnpm exec <binary> ...` / `yarn dlx <binary> ...`: classify the binary.
  if ((runner === "pnpm" || runner === "yarn") && (command === "exec" || command === "dlx")) {
    const [binary, ...binArgs] = rest;
    if (!binary) return local(profile, `${runner} ${command} without a binary stays local`, command, runner);
    return classifyNodeBinary(binary, binArgs, profile, runner);
  }
  if (command === "run") {
    const [script, ...scriptArgs] = rest;
    if (!script) return local(profile, "npm run without a script stays local", command, runner);
    if (NODE_WATCH_SCRIPT_RE.test(script)) return local(profile, `watch script ${script} stays local`, command, runner);
    if (NODE_PUBLISH_DENY_RE.test(script)) return local(profile, `script ${script} looks like a deploy/publish/release and stays local`, command, runner);
    if (isBuildScript(script)) {
      if (!isAllowedBuildScript(script)) return local(profile, `script ${script} is not an allowed build and stays local`, command, runner);
    } else if (!NODE_TEST_SCRIPT_RE.test(script)) {
      return local(profile, `script ${script} is not a test/e2e/build script`, command, runner);
    }
    const { selection, suiteDir } = nodePositionals(scriptArgs);
    const narrowed = nodeWatchOrNarrow(scriptArgs, null, suiteDir);
    if (narrowed) return local(profile, narrowed, command, runner);
    if (selection && !suiteDir) return local(profile, `single-file filter ${selection} stays local`, command, runner);
    return remote(profile, `eligible ${runner} run ${script}`, command, runner);
  }
  if (command === "test") {
    const { selection, suiteDir } = nodePositionals(rest);
    const narrowed = nodeWatchOrNarrow(rest, null, suiteDir);
    if (narrowed) return local(profile, narrowed, command, runner);
    if (selection && !suiteDir) return local(profile, `single-file filter ${selection} stays local`, command, runner);
    return remote(profile, `eligible ${runner} test`, command, runner);
  }
  if (NODE_LOCAL_COMMANDS.has(command)) return local(profile, `${runner} ${command} stays local`, command, runner);
  // `npx <binary> ...`, `pnpm <binary> ...`, `yarn <binary> ...`: test binaries
  // run through the package manager without run/exec.
  if (NODE_BIN_RUNNERS.has(runner)) return classifyNodeBinary(command, rest, profile, runner);
  return local(profile, `unrecognized ${runner} ${command} stays local`, command, runner);
}

// ---------------------------------------------------------------------------
// Python: pytest suites and `python -m pytest|unittest` suites. Single-test
// selection (-k narrow, :: node ids) stays local unless explicitly whole-suite;
// watch/repeat modes, inline code and anything unrecognized stay local.

const PYTHON_RUNNERS = new Set(["pytest", "python", "python3"]);
const PYTEST_NARROW_FLAGS = new Set(["-k", "-m", "--deselect", "--ignore"]);
const PYTEST_LOCAL_FLAGS = new Set(["--lf", "--ff", "--last-failed", "--failed", "--co", "--collect-only", "--stepwise"]);
/** Pytest flags that take a separate value: skip the value when scanning positionals. */
const PYTEST_VALUE_FLAGS = new Set([
  "-k", "-m", "--deselect", "--ignore", "--junitxml", "--junit-xml",
  "-o", "--rootdir", "-c", "--config",
]);
/** Unittest selectors only: --verbose/--failfast/--buffer/-v do not narrow. */
const UNITTEST_NARROW_EXACT = new Set(["-k", "--deselect", "--ignore"]);
const UNITTEST_NARROW_PREFIXES = ["-k=", "--deselect=", "--ignore="];
const UNITTEST_VALUE_FLAGS = new Set(["-k", "--deselect", "--ignore"]);

/** Bare positionals after skipping flag values. */
function barePytestPositionals(args: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  let seenDashDash = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (!seenDashDash && PYTEST_VALUE_FLAGS.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-") && !seenDashDash) continue;
    if (!seenDashDash && arg.includes("=")) continue;
    out.push(arg);
  }
  return out;
}

/** Bare positionals for unittest after skipping selector values. */
function bareUnittestPositionals(modArgs: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const arg of modArgs) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (UNITTEST_VALUE_FLAGS.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg.includes("=")) continue;
    out.push(arg);
  }
  return out;
}

function isPythonTestSelection(arg: string): boolean {
  return arg.includes("::");
}

function isPythonFileArg(arg: string): boolean {
  return !arg.startsWith("-") && /\.py$/i.test(arg);
}

/** A positional naming a suite directory (or the cwd) rather than a file. */
function isPythonSuiteDir(arg: string): boolean {
  if (arg.startsWith("-") || arg.includes("::")) return false;
  if (/\.py$/i.test(arg)) return false;
  return arg.includes("/") || arg === ".";
}

function classifyPytestArgs(args: string[], profile: ToolProfile, runner: string): CargoClassification {
  for (const arg of args) {
    if (isPythonTestSelection(arg)) return local(profile, `node id ${arg} stays local`, "pytest", runner);
    if (PYTEST_LOCAL_FLAGS.has(arg)) return local(profile, `${arg} selects a subset and stays local`, "pytest", runner);
  }
  const bare = barePytestPositionals(args);
  const narrowed = args.some((arg) => PYTEST_NARROW_FLAGS.has(arg) || arg.startsWith("--deselect=") || arg.startsWith("--ignore="));
  const hasFile = bare.some(isPythonFileArg);
  const hasSuiteDir = bare.some(isPythonSuiteDir);
  if (hasFile && !hasSuiteDir) return local(profile, "single-file selection stays local", "pytest", runner);
  if (narrowed && !hasSuiteDir) return local(profile, "narrowed selection stays local without an explicit suite", "pytest", runner);
  return remote(profile, "eligible pytest suite", "pytest", runner);
}

/**
 * Classify a Python invocation: runner plus argv without the executable.
 * Remote candidates are narrow: whole pytest/unittest suites. Single-test
 * selection, inline code and anything unrecognized stay local.
 */
export function classifyPython(runner: string, argv: string[], profile: ToolProfile): CargoClassification {
  if (!PYTHON_RUNNERS.has(runner)) return local(profile, `unrecognized python runner ${runner} stays local`, null, runner);
  // Bare `pytest` runs the whole suite; bare `python` is a REPL and stays local.
  if (argv.length === 0) {
    return runner === "pytest"
      ? remote(profile, "eligible pytest suite", "pytest", runner)
      : local(profile, "empty argv", null, runner);
  }
  if (isCompoundShell(argv)) return local(profile, "compound shell text stays local", null, runner);
  if (runner === "pytest") return classifyPytestArgs(argv, profile, runner);
  // `python[3] -m pytest|unittest ...`, nothing else. `-c` is inline code only
  // when there is no `-m` (pytest `-c/--config` takes a config-file value).
  if (argv[0] === "-c" || (argv.includes("-c") && !argv.includes("-m"))) return local(profile, "python -c stays local", null, runner);
  if (argv[0] !== "-m") return local(profile, "only python -m pytest|unittest suites are eligible", null, runner);
  const [mod, ...modArgs] = argv.slice(1);
  if (mod === "pytest") return classifyPytestArgs(modArgs, profile, runner);
  if (mod === "unittest") {
    if (modArgs.some((arg) => arg.includes("::"))) return local(profile, "node id stays local", "unittest", runner);
    const bare = bareUnittestPositionals(modArgs);
    const dotted = bare.some((arg) => arg.includes("."));
    const narrowed = modArgs.some((arg) => UNITTEST_NARROW_EXACT.has(arg) || UNITTEST_NARROW_PREFIXES.some((p) => arg.startsWith(p)));
    if ((dotted || narrowed) && !bare.some((arg) => !arg.includes(".") && (arg.includes("/") || arg === "."))) {
      return local(profile, "single-test selection stays local", "unittest", runner);
    }
    return remote(profile, "eligible unittest suite", "unittest", runner);
  }
  return local(profile, `python -m ${mod ?? "(bare)"} stays local`, null, runner);
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
  const cargoSide = cargoSideArgv(argv);
  if (cargoSide.some((arg) => arg === "--config" || arg.startsWith("--config="))) {
    return local(profile, "unrecognized --config override stays local");
  }
  if (cargoSide.some((arg) => arg === "-Z" || arg.startsWith("-Z"))) {
    return local(profile, "unstable -Z flags stay local");
  }
  // The executor refuses every path-bearing override rather than rewrite host
  // paths; classify them local up front so dry-run agrees with dispatch.
  const pathFlag = cargoSide.find((arg) => CARGO_PATH_FLAG_RE.test(arg));
  if (pathFlag !== undefined) return local(profile, `path-bearing option ${pathFlag.split("=")[0]} stays local`);

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
