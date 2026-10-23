// Agent-authenticated offload route handlers. The host verifies the run token
// and resolves the company before dispatch; these handlers additionally bind
// the principal (company, run) to the execution workspace via host-owned
// metadata. Body identifiers are consistency checks, never authority: no
// caller-selected root, endpoint, VM, shell or environment is trusted.

import type { OffloadBroker, BrokerPrincipal } from "./broker.js";
import { offloadError } from "./errors.js";
import { OFFLOAD_BOUNDS, OFFLOAD_VERSION } from "./protocol.js";
import { classifyCargo } from "./router.js";
import { bodyTooLarge, validateSubmit } from "./validate.js";

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
  toolchains: string[];
  allowRustflags: boolean;
}

export interface OffloadRouteHost {
  broker: OffloadBroker;
  workspaces: {
    get(workspaceId: string, companyId: string): Promise<OffloadWorkspaceMeta | null>;
  };
  profile: ServerProfile;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** v1 built-in server profile: public-source, secret-free Rust builds/tests. */
export const V1_PROFILE: ServerProfile = {
  id: "rust-public-1",
  toolchains: ["stable", "1.88.0"],
  allowRustflags: false,
};

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
  const validated = validateSubmit(input.body, { allowRustflags: host.profile.allowRustflags });
  if (!validated.ok) {
    return { status: 400, body: offloadError("OFFLOAD_INVALID_REQUEST", validated.detail, {}) };
  }
  const request = validated.value;
  const workspace = await host.workspaces.get(request.executionWorkspaceId, input.companyId);
  if (!workspace) {
    return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", "unknown execution workspace", { commandId: request.commandId }) };
  }
  const principal = principalFor(input.companyId, runId, workspace, host.profile);
  if (request.dryRun) {
    // Dry run validates and classifies with no VM, sync, budget reservation
    // or journal effect. A remote candidate is not a capacity promise.
    const classification = classifyCargo(request.argv, host.profile);
    return {
      status: 200,
      body: { version: OFFLOAD_VERSION, commandId: request.commandId, mode: classification.mode, reason: classification.reason, profileId: host.profile.id },
    };
  }
  if (workspace.path == null && workspace.cwd == null) {
    await host.broker.recordRefusal(request, principal, "execution workspace is not locally realized; cannot snapshot source");
    return {
      status: 503,
      body: offloadError("OFFLOAD_UNAVAILABLE", "execution workspace confinement is unsupported", { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
    };
  }
  const classification = classifyCargo(request.argv, host.profile);
  if (classification.mode === "local") {
    await host.broker.recordRefusal(request, principal, `incompatible workload: ${classification.reason}`);
    return {
      status: 503,
      body: offloadError("OFFLOAD_UNAVAILABLE", `incompatible workload: ${classification.reason}`, { commandId: request.commandId, remoteStarted: false, fallbackSafe: true }),
    };
  }
  return host.broker.submit(request, principal);
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
