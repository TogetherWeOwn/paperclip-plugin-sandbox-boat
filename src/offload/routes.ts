// Agent-authenticated offload route handlers. The host verifies the run token
// and resolves the company before dispatch; these handlers additionally bind
// the principal (company, run) to the execution workspace via host-owned
// metadata. Body identifiers are consistency checks, never authority: no
// caller-selected root, endpoint, VM, shell or environment is trusted.

import type { OffloadBroker, BrokerPrincipal } from "./broker.js";
import { durationKey, medianSeconds, normalizeSignature, readHistory, recordDuration, type DurationStore } from "./duration-history.js";
import { offloadError } from "./errors.js";
import { OFFLOAD_BOUNDS, OFFLOAD_VERSION, type OffloadTool } from "./protocol.js";
import { classifyCargo, classifyNode, classifyPython, type CargoClassification } from "./router.js";
import { bodyTooLarge, LONE_SURROGATE, validateSubmit } from "./validate.js";

/** The refusal path must answer the same documented 409 as submit() for a reused ID. */
async function recordRefusalOrConflict(
  broker: OffloadBroker,
  request: Parameters<OffloadBroker["recordRefusal"]>[0],
  principal: BrokerPrincipal,
  reason: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    await broker.recordRefusal(request, principal, reason);
    return null;
  } catch (error) {
    if ((error as { code?: string }).code !== "OFFLOAD_IDEMPOTENCY_CONFLICT") throw error;
    return {
      status: 409,
      body: offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "commandId already used with a different payload", { commandId: request.commandId }),
    };
  }
}

export interface RouteActor {
  actorType: "user" | "agent";
  actorId: string;
  runId: string | null;
}

export interface OffloadWorkspaceMeta {
  repoUrl: string | null;
  projectId: string;
  projectWorkspaceId: string | null;
  path: string | null;
  cwd: string | null;
}

export interface ServerProfile {
  id: string;
  tool?: OffloadTool;
  toolchains: string[];
  allowRustflags: boolean;
  runners?: string[];
}

export interface OffloadSettings {
  /** Profile ids admitted for remote dispatch. Default ["rust-public-1"]: Node/Python are opt-in. */
  offloadProfiles: string[];
  /** A Node/Python signature is a remote candidate only at/above this recorded median. */
  offloadMinExpectedSeconds: number;
  /** Monthly cap on tracked offload VM-hours; 0 disables the extra cap. */
  offloadMonthlyVmHourCap: number;
}

export interface OffloadRouteHost {
  broker: OffloadBroker;
  workspaces: {
    get(workspaceId: string, companyId: string, runId: string): Promise<OffloadWorkspaceMeta | null>;
  };
  profile: ServerProfile;
  extraProfiles?: ServerProfile[];
  settings?: Partial<OffloadSettings>;
  durations?: DurationStore;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** v1 built-in server profile: public-source, secret-free Rust builds/tests. */
export const V1_PROFILE: ServerProfile = {
  id: "rust-public-1",
  tool: "cargo",
  toolchains: ["stable", "1.88.0"],
  allowRustflags: false,
  runners: ["cargo"],
};

/** Node test/e2e/build profile: npm/pnpm/yarn scripts and test binaries. */
export const NODE_PROFILE: ServerProfile = {
  id: "node-public-1",
  tool: "node",
  toolchains: [],
  allowRustflags: false,
  runners: ["npm", "pnpm", "yarn", "npx"],
};

/** Python suite profile: pytest and python -m pytest/unittest. */
export const PYTHON_PROFILE: ServerProfile = {
  id: "python-public-1",
  tool: "python",
  toolchains: [],
  allowRustflags: false,
  runners: ["pytest", "python", "python3"],
};

export const DEFAULT_SETTINGS: OffloadSettings = {
  offloadProfiles: ["rust-public-1"],
  offloadMinExpectedSeconds: 120,
  offloadMonthlyVmHourCap: 0,
};

const KNOWN_PROFILE_IDS = new Set(["rust-public-1", "node-public-1", "python-public-1"]);
const KNOWN_TOOLS: ReadonlySet<string> = new Set(["cargo", "node", "python"]);

/** Sanitize company plugin config; unknown values fall back to defaults. */
export function normalizeOffloadSettings(raw: unknown): OffloadSettings {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const profiles = Array.isArray(record.offloadProfiles)
    ? record.offloadProfiles.filter((id): id is string => typeof id === "string" && KNOWN_PROFILE_IDS.has(id))
    : [...DEFAULT_SETTINGS.offloadProfiles];
  const min = Number(record.offloadMinExpectedSeconds);
  const cap = Number(record.offloadMonthlyVmHourCap);
  return {
    offloadProfiles: profiles,
    offloadMinExpectedSeconds: Number.isFinite(min) && min >= 0 ? min : DEFAULT_SETTINGS.offloadMinExpectedSeconds,
    offloadMonthlyVmHourCap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_SETTINGS.offloadMonthlyVmHourCap,
  };
}

export function profileTool(profile: ServerProfile): OffloadTool {
  return profile.tool ?? "cargo";
}

export function profileRunners(profile: ServerProfile): string[] {
  if (profile.runners) return profile.runners;
  return profileTool(profile) === "cargo" ? ["cargo"] : [];
}

export function defaultRunnerFor(tool: OffloadTool): string {
  return tool === "node" ? "npm" : tool === "python" ? "pytest" : "cargo";
}

function profileFor(host: OffloadRouteHost, tool: OffloadTool): ServerProfile | null {
  if (profileTool(host.profile) === tool) return host.profile;
  for (const extra of host.extraProfiles ?? []) {
    if (profileTool(extra) === tool) return extra;
  }
  if (tool === "node") return NODE_PROFILE;
  if (tool === "python") return PYTHON_PROFILE;
  return null;
}

export function classifyRequest(profile: ServerProfile, tool: OffloadTool, runner: string, argv: string[]): CargoClassification {
  if (tool === "node") return classifyNode(runner, argv, profile);
  if (tool === "python") return classifyPython(runner, argv, profile);
  return classifyCargo(argv, { id: profile.id, toolchains: profile.toolchains });
}

export function canonicalRepoId(workspace: { repoUrl: string | null; projectId: string }): string {
  const url = workspace.repoUrl?.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (url) return `repo:${url.toLowerCase()}`;
  return `project:${workspace.projectId}`;
}

function authed(actor: RouteActor): string | null {
  if (actor.actorType !== "agent" || !actor.runId) return null;
  return actor.runId;
}

function principalFor(companyId: string, runId: string, workspace: OffloadWorkspaceMeta, profile: ServerProfile): BrokerPrincipal {
  return {
    companyId,
    runId,
    // The route layer cannot resolve run -> card from host metadata yet; the
    // usage reconciler joins on runId. Never taken from the request body.
    cardId: "",
    repoId: canonicalRepoId(workspace),
    profileId: profile.id,
  };
}

export async function handleExec(
  input: { actor: RouteActor; companyId: string; body: unknown },
  host: OffloadRouteHost,
): Promise<RouteResponse> {
  const runId = authed(input.actor);
  if (!runId) return { status: 401, body: offloadError("OFFLOAD_UNAUTHORIZED", "agent run authentication required", {}) };
  // The host delivers a parsed body; bound its re-encoded size (host ingress
  // limits bound the wire form).
  if (bodyTooLarge(JSON.stringify(input.body ?? null))) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "request body exceeds 64 KiB", {}) };
  }
  const rawTool = toolOfBody(input.body);
  if (rawTool === null) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "tool must be cargo, node or python", {}) };
  }
  const profile = profileFor(host, rawTool);
  if (!profile) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "tool must be cargo, node or python", {}) };
  }
  const validated = validateSubmit(input.body, {
    allowRustflags: profile.allowRustflags,
    tool: profileTool(profile),
    runners: profileRunners(profile),
  });
  if (!validated.ok) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", validated.detail, {}) };
  }
  const request = validated.value;
  const tool = request.tool ?? profileTool(profile);
  const runner = request.runner ?? defaultRunnerFor(tool);
  const settings: OffloadSettings = { ...DEFAULT_SETTINGS, ...host.settings };
  if (!settings.offloadProfiles.includes(profile.id)) {
    // Not journaled as a refusal: enabling the profile later must accept the
    // same command ID. The shim falls back locally.
    return {
      status: 503,
      body: offloadError("OFFLOAD_UNAVAILABLE", `profile ${profile.id} is not enabled for offload`, { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
    };
  }
  const workspace = await host.workspaces.get(request.executionWorkspaceId, input.companyId, runId);
  if (!workspace) {
    return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "unknown execution workspace", { commandId: request.commandId }) };
  }
  const principal = principalFor(input.companyId, runId, workspace, profile);
  if (request.dryRun) {
    // Dry run validates and classifies with no VM, sync, budget reservation
    // or journal effect. A remote candidate is not a capacity promise.
    const classification = await decideRemote(host, settings, canonicalRepoId(workspace), profile, tool, runner, request.argv);
    return {
      status: 200,
      body: { version: OFFLOAD_VERSION, commandId: request.commandId, mode: classification.mode, reason: classification.reason, profileId: profile.id },
    };
  }
  if (workspace.path == null && workspace.cwd == null) {
    const conflict = await recordRefusalOrConflict(host.broker, request, principal, "execution workspace is not locally realized; cannot snapshot source");
    if (conflict) return conflict;
    return {
      status: 503,
      body: offloadError("OFFLOAD_UNAVAILABLE", "execution workspace confinement is unsupported", { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
    };
  }
  const classification = await decideRemote(host, settings, canonicalRepoId(workspace), profile, tool, runner, request.argv);
  if (classification.mode === "local") {
    const conflict = await recordRefusalOrConflict(host.broker, request, principal, `incompatible workload: ${classification.reason}`);
    if (conflict) return conflict;
    return {
      status: 503,
      body: offloadError("OFFLOAD_UNAVAILABLE", `incompatible workload: ${classification.reason}`, { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
    };
  }
  return host.broker.submit(request, principal);
}

/** Read the requested tool off the raw body before profile validation. Null when invalid. */
function toolOfBody(body: unknown): OffloadTool | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "cargo";
  const tool = (body as Record<string, unknown>).tool;
  if (tool === undefined) return "cargo";
  return typeof tool === "string" && KNOWN_TOOLS.has(tool) ? (tool as OffloadTool) : null;
}

/**
 * Workload decision: classifier first, then the Node/Python duration gate.
 * Rust keeps its existing behaviour ( classifier verdict, no duration gate).
 */
async function decideRemote(
  host: OffloadRouteHost,
  settings: OffloadSettings,
  repoId: string,
  profile: ServerProfile,
  tool: OffloadTool,
  runner: string,
  argv: string[],
): Promise<CargoClassification> {
  const classification = classifyRequest(profile, tool, runner, argv);
  if (classification.mode === "local" || tool === "cargo") return classification;
  if (!host.durations) {
    return { mode: "local", reason: "duration learning unavailable; run local first", profileId: profile.id, subcommand: classification.subcommand, runner };
  }
  const key = durationKey(repoId, profile.id, normalizeSignature(tool, runner, argv));
  const history = await readHistory(host.durations, key);
  if (history.length === 0) {
    return { mode: "local", reason: "no duration history yet; run local first and record", profileId: profile.id, subcommand: classification.subcommand, runner };
  }
  const median = medianSeconds(history, Date.now());
  if (median !== null && median >= settings.offloadMinExpectedSeconds) return classification;
  return {
    mode: "local",
    reason: `median ${median === null ? "unknown" : `${median.toFixed(0)}s`} below ${settings.offloadMinExpectedSeconds}s threshold; runs local and records`,
    profileId: profile.id,
    subcommand: classification.subcommand,
    runner,
  };
}

/**
 * Local-run duration report: the shim records wall-clock seconds for a
 * remote-candidate command it ran locally (unknown or short history), so the
 * next identical command can go remote. Never dispatches, never journals a
 * command; it only appends one bounded sample.
 */
export async function handleReport(
  input: { actor: RouteActor; companyId: string; body: unknown },
  host: OffloadRouteHost,
): Promise<RouteResponse> {
  const runId = authed(input.actor);
  if (!runId) return { status: 401, body: offloadError("OFFLOAD_UNAUTHORIZED", "agent run authentication required", {}) };
  if (bodyTooLarge(JSON.stringify(input.body ?? null))) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "request body exceeds 64 KiB", {}) };
  }
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "body must be a JSON object", {}) };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.executionWorkspaceId !== "string" || !UUID_RE.test(record.executionWorkspaceId)) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "executionWorkspaceId must be a UUID", {}) };
  }
  if (record.tool !== "node" && record.tool !== "python") {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "tool must be node or python", {}) };
  }
  const tool = record.tool as OffloadTool;
  const profile = profileFor(host, tool)!;
  if (typeof record.runner !== "string" || !profileRunners(profile).includes(record.runner)) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "runner is not allowed on this profile", {}) };
  }
  const argv = record.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > OFFLOAD_BOUNDS.maxArgs
    || argv.some((a) => typeof a !== "string" || a.length === 0)) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "argv must be a non-empty array of non-empty strings", {}) };
  }
  if (argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg) || LONE_SURROGATE.test(arg))) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "argv holds invalid control characters", {}) };
  }
  if (typeof record.durationSeconds !== "number" || !Number.isFinite(record.durationSeconds)
    || record.durationSeconds < 0 || record.durationSeconds > 86_400) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "durationSeconds must be 0..86400", {}) };
  }
  if (!host.durations) {
    return { status: 503, body: offloadError("OFFLOAD_UNAVAILABLE", "duration learning unavailable", { commandId: null, remoteStarted: false, fallbackSafe: true }) };
  }
  const workspace = await host.workspaces.get(record.executionWorkspaceId, input.companyId, runId);
  if (!workspace) {
    return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "unknown execution workspace", { commandId: null }) };
  }
  const key = durationKey(canonicalRepoId(workspace), profile.id, normalizeSignature(tool, record.runner, argv as string[]));
  await recordDuration(host.durations, key, { seconds: record.durationSeconds, at: Date.now() });
  return { status: 200, body: { version: OFFLOAD_VERSION, recorded: true } };
}

function readAuth(input: { actor: RouteActor; params: { commandId?: string } }): { runId: string; commandId: string } | RouteResponse {
  const runId = authed(input.actor);
  if (!runId) return { status: 401, body: offloadError("OFFLOAD_UNAUTHORIZED", "agent run authentication required", {}) };
  const commandId = input.params.commandId ?? "";
  if (!UUID_RE.test(commandId)) return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "commandId must be a UUID", {}) };
  return { runId, commandId };
}

export async function handleRead(
  input: { actor: RouteActor; companyId: string; params: { commandId?: string }; query: Record<string, string | string[]> },
  host: OffloadRouteHost,
): Promise<RouteResponse> {
  const auth = readAuth(input);
  if (!isAuthed(auth)) return auth;
  const afterRaw = firstQuery(input.query.after);
  const after = afterRaw === null ? 0 : Number(afterRaw);
  if (!Number.isInteger(after) || after < 0) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", "after must be a non-negative integer", { commandId: auth.commandId }) };
  }
  const limitRaw = firstQuery(input.query.limitBytes);
  const limitParsed = limitRaw === null ? OFFLOAD_BOUNDS.readLimitBytes : Number(limitRaw);
  const limitBytes = Number.isFinite(limitParsed) ? Math.min(Math.max(1, Math.floor(limitParsed)), OFFLOAD_BOUNDS.readLimitBytes) : OFFLOAD_BOUNDS.readLimitBytes;
  return host.broker.read(auth.commandId, { companyId: input.companyId, runId: auth.runId }, after, limitBytes);
}

export async function handleHeartbeat(
  input: { actor: RouteActor; companyId: string; params: { commandId?: string } },
  host: OffloadRouteHost,
): Promise<RouteResponse> {
  const auth = readAuth(input);
  if (!isAuthed(auth)) return auth;
  return host.broker.heartbeat(auth.commandId, { companyId: input.companyId, runId: auth.runId });
}

export async function handleCancel(
  input: { actor: RouteActor; companyId: string; params: { commandId?: string }; body: unknown },
  host: OffloadRouteHost,
): Promise<RouteResponse> {
  const auth = readAuth(input);
  if (!isAuthed(auth)) return auth;
  const reason = input.body != null && typeof input.body === "object" && typeof (input.body as Record<string, unknown>).reason === "string"
    ? String((input.body as Record<string, unknown>).reason).slice(0, 128)
    : "client";
  return host.broker.cancel(auth.commandId, { companyId: input.companyId, runId: auth.runId }, reason);
}

function firstQuery(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function isAuthed(value: { runId: string; commandId: string } | RouteResponse): value is { runId: string; commandId: string } {
  return (value as RouteResponse).status === undefined;
}
