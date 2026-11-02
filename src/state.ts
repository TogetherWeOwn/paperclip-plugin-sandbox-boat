// Plugin state: one JSON document per company (scope "company"), holding the
// card -> boat sandbox mapping and the per-run usage ledger. Writes are
// serialized in-process; the worker is the only writer.
import type { BoatSize } from "./config.js";

export type VmKeyKind = "executionWorkspace" | "issue" | "run";
export type VmStatus = "starting" | "running" | "stopping" | "stopped" | "deleted";
export type StartKind = "create" | "create_from_snapshot" | "resume" | "reuse_running";

export interface UsageReading {
  seconds: number;
  dollars: number;
  source: "boat" | "estimate";
  at: string;
}

export interface RunSession {
  runId: string;
  agentId: string | null;
  startKind: StartKind;
  size: BoatSize;
  startedAt: string;
  endedAt: string | null;
  usage: UsageReading | null;
}

export interface VmRecord {
  key: string;
  keyKind: VmKeyKind;
  sandboxId: string;
  name: string;
  companyId: string;
  environmentId: string;
  issueId: string | null;
  executionWorkspaceId: string | null;
  size: BoatSize;
  status: VmStatus;
  activeRunIds: string[];
  createdAt: string;
  lastStartedAt: string;
  lastStoppedAt: string | null;
  lastActivityAt: string;
  archiveAfter: string | null;
  hardDeadline: string | null;
  starts: number;
  lifetimeUsage: UsageReading | null;
  sessions: RunSession[];
  deletedAt: string | null;
  /**
   * Workspace roots the plugin set up or realized on this VM (absolute VM
   * paths). Paperclip puts its runtime assets, the run MCP config with the run
   * JWT among them, under `<root>/.paperclip-runtime/`, so the scrub before a
   * stop looks there. Absent on records written before 0.2.0.
   */
  remoteRoots?: string[];
  /**
   * The only agent this VM's disk may ever be handed to: a resumed or running
   * disk keeps whatever an earlier run planted in it (shell hooks, toolchain
   * shims), so it must never serve a different principal's credentials. The
   * VM key already scopes lookups by a digest of this id; the field is kept
   * so acquire can refuse a record whose principal differs (a pre-scoping or
   * hand-edited record). Absent on records written before the scoping: those
   * are unknown-principal and no named agent reuses them.
   */
  principalAgentId?: string | null;
}

const MAX_REMOTE_ROOTS = 8;

/** Add an absolute VM path to a record's roots (newest last, at most 8). */
export function mergeRemoteRoot(roots: readonly string[] | undefined, root: string | null | undefined): string[] {
  const list = [...(roots ?? [])];
  const value = root?.trim().replace(/\/+$/, "") ?? "";
  if (!value.startsWith("/") || value.length < 2) return list;
  const next = [...list.filter((entry) => entry !== value), value];
  return next.slice(-MAX_REMOTE_ROOTS);
}

export interface StateDoc {
  version: 1;
  vms: Record<string, VmRecord>;
}

export interface StateClientLike {
  get(input: { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string }): Promise<unknown>;
  set(
    input: { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string },
    value: unknown,
  ): Promise<void>;
  delete(input: { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string }): Promise<void>;
}

const NAMESPACE = "boat-sandbox";
const VMS_KEY = "vms";
const COMPANIES_KEY = "companies";
const MAX_SESSIONS_PER_VM = 100;
const TOMBSTONE_KEEP_MS = 30 * 24 * 3600 * 1000;

function emptyDoc(): StateDoc {
  return { version: 1, vms: {} };
}

function normalizeDoc(value: unknown): StateDoc {
  if (!value || typeof value !== "object") return emptyDoc();
  const doc = value as Partial<StateDoc>;
  if (doc.version !== 1 || !doc.vms || typeof doc.vms !== "object") return emptyDoc();
  return { version: 1, vms: { ...doc.vms } };
}

export class VmStateStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: StateClientLike) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async read(companyId: string): Promise<StateDoc> {
    return normalizeDoc(await this.state.get({ scopeKind: "company", scopeId: companyId, namespace: NAMESPACE, stateKey: VMS_KEY }));
  }

  /**
   * A separate per-VM heartbeat: lifecycle read-modify-writes of the company
   * document must not erase a long command's activity from another manager.
   * Only a timestamp crosses this boundary, never command text or output.
   */
  async touchActivity(companyId: string, sandboxId: string, at: number): Promise<void> {
    await this.serialize(() => this.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: NAMESPACE, stateKey: `activity:${sandboxId}` },
      at,
    ));
  }

  async activityAt(companyId: string, sandboxId: string): Promise<number> {
    const at = await this.state.get({
      scopeKind: "company", scopeId: companyId, namespace: NAMESPACE, stateKey: `activity:${sandboxId}`,
    });
    if (at == null) return 0; // VMs created before heartbeat support.
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      throw new Error("boat: invalid shared activity timestamp; refusing an idle stop");
    }
    return at;
  }

  /** Read-modify-write, serialized with every other write in this worker. */
  async update<T>(companyId: string, fn: (doc: StateDoc) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const doc = await this.read(companyId);
      const result = await fn(doc);
      prune(doc, Date.now());
      await this.state.set({ scopeKind: "company", scopeId: companyId, namespace: NAMESPACE, stateKey: VMS_KEY }, doc);
      return result;
    });
  }

  async rememberCompany(companyId: string): Promise<void> {
    return this.serialize(async () => {
      const raw = await this.state.get({ scopeKind: "instance", namespace: NAMESPACE, stateKey: COMPANIES_KEY });
      const list = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
      if (list.includes(companyId)) return;
      await this.state.set({ scopeKind: "instance", namespace: NAMESPACE, stateKey: COMPANIES_KEY }, [...list, companyId]);
    });
  }

  async companies(): Promise<string[]> {
    const raw = await this.state.get({ scopeKind: "instance", namespace: NAMESPACE, stateKey: COMPANIES_KEY });
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
  }
}

export function findBySandboxId(doc: StateDoc, sandboxId: string): VmRecord | null {
  for (const record of Object.values(doc.vms)) {
    if (record.sandboxId === sandboxId) return record;
  }
  return null;
}

function prune(doc: StateDoc, now: number): void {
  for (const [key, record] of Object.entries(doc.vms)) {
    if (record.sessions.length > MAX_SESSIONS_PER_VM) {
      record.sessions = record.sessions.slice(-MAX_SESSIONS_PER_VM);
    }
    if (record.status === "deleted" && record.deletedAt && now - Date.parse(record.deletedAt) > TOMBSTONE_KEEP_MS) {
      delete doc.vms[key];
    }
  }
}
