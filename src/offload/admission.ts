// Operator-owned exact-run admission. The host, never the request body or
// environment, supplies authenticatedRunId and an atomic durable state create.
import { createHash } from "node:crypto";
import type { StateClientLike } from "../state.js";
import type { BrokerPrincipal } from "./broker.js";
import { offloadError } from "./errors.js";
import type { OffloadSubmitRequest } from "./protocol.js";
import type { RouteActor, RouteResponse } from "./routes.js";

export interface OffloadAdmissionPolicy {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  executionWorkspaceId: string;
  commandId: string;
  issuedAt: string;
  expiresAt: string;
}

/** No get/set emulation is safe here. Only a host-backed, atomic insert-if-
 * absent may implement this port; old hosts deliberately cannot admit work. */
export interface AdmissionState extends StateClientLike {
  create?: (input: Parameters<StateClientLike["get"]>[0], value: unknown) => Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ADMISSION_MAX_WINDOW_MS = 75 * 60_000;
const FIELDS = ["version", "companyId", "agentId", "runId", "executionWorkspaceId", "commandId", "issuedAt", "expiresAt"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): number => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN;

/** Missing, empty, broad, malformed and unknown-version policies all deny. */
export function parseAdmissionPolicy(value: unknown): OffloadAdmissionPolicy | null {
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== FIELDS.length
    || Object.keys(value).some((key) => !FIELDS.includes(key))
    || !["companyId", "agentId", "runId", "executionWorkspaceId", "commandId"].every((key) => typeof value[key] === "string" && UUID.test(value[key]))) return null;
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > ADMISSION_MAX_WINDOW_MS) return null;
  return { ...value } as unknown as OffloadAdmissionPolicy;
}

interface Claim {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  executionWorkspaceId: string;
  commandId: string;
  digest: string;
  consumedAt: number;
}

export class OffloadAdmission {
  constructor(private readonly state: AdmissionState, private readonly now: () => number,
    private readonly config: (companyId: string) => Promise<Record<string, unknown> | undefined>) {}

  private scope(companyId: string, runId: string) {
    // Separate from broker/executor journals and their retention. Never clear
    // this tombstone on expiry, cancellation, config replacement or shutdown.
    return { scopeKind: "company" as const, scopeId: companyId, namespace: "boat-offload-admission-v1", stateKey: runId };
  }

  private refuse(request: OffloadSubmitRequest, detail: string): RouteResponse {
    return { status: 403, body: offloadError("OFFLOAD_FORBIDDEN", detail, { commandId: request.commandId }) };
  }

  private spent(request: OffloadSubmitRequest): RouteResponse {
    // Consume may have succeeded before a journal write or response was lost.
    // No receipt means unknown, never permission to start again or go local.
    return { status: 409, body: offloadError("OFFLOAD_EXECUTION_UNKNOWN", "run command grant already consumed; use existing receipts, never remint or replay", {
      commandId: request.commandId, remoteStarted: null, fallbackSafe: false,
    }) };
  }

  private async policy(companyId: string, actor: RouteActor, request: OffloadSubmitRequest): Promise<RouteResponse | null> {
    if (actor.actorType !== "agent" || !actor.agentId || !actor.authenticatedRunId || actor.authenticatedRunId !== actor.runId) {
      return this.refuse(request, "verified exact-run authentication is required for new admission");
    }
    const config = await this.config(companyId);
    const policy = parseAdmissionPolicy(config?.offloadAdmission);
    if (!policy || config?.offloadExecutorEnabled !== true) return this.refuse(request, "exact-run admission is disabled or malformed");
    const now = this.now();
    if (now < timestamp(policy.issuedAt) || now >= timestamp(policy.expiresAt)) return this.refuse(request, "exact-run admission is outside its validity window");
    if (policy.companyId !== companyId || policy.agentId !== actor.agentId || policy.runId !== actor.authenticatedRunId
      || policy.executionWorkspaceId !== request.executionWorkspaceId || policy.commandId !== request.commandId) {
      return this.refuse(request, "request does not match the operator's exact run, workspace and command grant");
    }
    if (typeof this.state.create !== "function") return this.refuse(request, "host atomic admission storage is unavailable");
    return null;
  }

  /** Read-only, also before first-request binding. Does not reserve capacity. */
  async check(companyId: string, actor: RouteActor, request: OffloadSubmitRequest): Promise<RouteResponse | null> {
    try {
      const refused = await this.policy(companyId, actor, request);
      if (refused) return refused;
      if (await this.state.get(this.scope(companyId, actor.runId!)) !== null) return this.spent(request);
      return null;
    } catch {
      return this.refuse(request, "exact-run admission could not be verified");
    }
  }

  /** Invoked inside broker admission, after read-only validation and before
   * journal intent/enqueue. Only the winner of the durable insert dispatches.
   * A crash between this insert and the journal may spend without executing:
   * at-most-once is intentional; no code deletes or overwrites this claim. */
  async consume(companyId: string, actor: RouteActor, request: OffloadSubmitRequest, principal: BrokerPrincipal): Promise<RouteResponse | null> {
    try {
      const refused = await this.policy(companyId, actor, request);
      if (refused) return refused;
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
      const { dryRun: _dryRun, ...execution } = request;
      const claim: Claim = { version: 1, companyId, agentId: actor.agentId!, runId: actor.runId!,
        executionWorkspaceId: request.executionWorkspaceId, commandId: request.commandId, consumedAt: this.now(),
        digest: createHash("sha256").update(JSON.stringify(canonical({ ...execution, principal }))).digest("hex") };
      return await this.state.create!(this.scope(companyId, actor.runId!), claim) === true ? null : this.spent(request);
    } catch {
      // An ambiguous insert acknowledgement may already have consumed. Do not
      // describe a storage failure as a safe local fallback.
      return this.spent(request);
    }
  }
}
