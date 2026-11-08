// Duration learning so only LONG Node/Python commands go remote.
// Per company + repo + profile + normalized command signature, keeps the last
// 20 durations with a 30-day TTL in plugin state. A command is a remote
// candidate only when its recorded median meets the configured threshold;
// unknown signatures run local first and record. Rust keeps its existing
// behaviour and is never gated here.

import path from "node:path";
import type { DepSelection } from "./deps-install.js";

export interface DurationSample {
  /** Wall-clock seconds for one local or remote run. */
  seconds: number;
  /** Epoch millis when the run finished. */
  at: number;
}

export interface DurationStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export const DURATION_HISTORY_LIMIT = 20;
export const DURATION_HISTORY_TTL_MS = 30 * 24 * 60 * 60_000;
/** Upper bound for any learned sample: learning never exceeds one day. */
export const MAX_DURATION_SECONDS = 86_400;
/**
 * Bound on duration keys per company scope (shared across repos: the index
 * key lives in company-scoped state). One state key holds the LRU
 * signature index; evicted and expired keys are deleted, so an agent looping
 * unique argv cannot grow plugin state without bound.
 */
export const DURATION_INDEX_LIMIT = 500;
export const DURATION_INDEX_KEY = "offload.duration-index.v1";
const KEY_PREFIX = "offload.duration.v1.";

export function durationKey(repoId: string, profileId: string, signature: string): string {
  return `${KEY_PREFIX}${repoId}\u0000${profileId}\u0000${signature}`;
}

/**
 * Normalized command signature: tool + runner + exact argv + run directory.
 * Single-test selections naturally form their own signatures (they stay
 * unknown/local), so no fuzzy normalization that could promote a short command
 * to remote. The workspace root keeps the original three-part encoding, so
 * history recorded before the directory was part of the key stays valid.
 * A validated selection has its own signature; its cwd already equals the
 * command cwd. Omitted selections retain both legacy default encodings.
 */
export function normalizeSignature(tool: string, runner: string, argv: string[], cwdRelative = ".", depSelection?: DepSelection): string {
  const cwd = path.posix.normalize(cwdRelative).replace(/\/+$/, "") || ".";
  if (depSelection !== undefined) return JSON.stringify([tool, runner, argv, cwd, { uvExtra: depSelection.uvExtra }]);
  return cwd === "." ? JSON.stringify([tool, runner, argv]) : JSON.stringify([tool, runner, argv, cwd]);
}

function isSample(value: unknown): value is DurationSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.seconds === "number" && Number.isFinite(sample.seconds) && sample.seconds >= 0
    && typeof sample.at === "number" && Number.isInteger(sample.at) && sample.at > 0;
}

export function medianSeconds(samples: DurationSample[], now: number): number | null {
  const fresh = samples.filter(isSample).filter((sample) => now - sample.at <= DURATION_HISTORY_TTL_MS);
  if (fresh.length === 0) return null;
  const sorted = fresh.map((sample) => sample.seconds).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** True when the recorded median meets the threshold (unknown history: false). */
export function isLongEnough(samples: DurationSample[], now: number, minExpectedSeconds: number): boolean {
  const median = medianSeconds(samples, now);
  return median !== null && median >= minExpectedSeconds;
}

export async function readHistory(store: DurationStore, key: string): Promise<DurationSample[]> {
  const raw = await store.get(key);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSample);
}

// Both writers (the report route and the remote-completion hook) run in this
// worker, so one in-process mutex serializes every duration mutation: history
// writes, index updates and sweeps. A per-key lock would still let a newcomer's
// eviction delete a history another signature just stored (the eviction runs
// under a different lock), so the whole read-modify-write-index cycle is one
// critical section instead.
let tail: Promise<unknown> = Promise.resolve();
async function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const pending = tail.then(fn);
  tail = pending.catch(() => undefined);
  return pending;
}

interface IndexEntry {
  key: string;
  /** Newest sample time: entries only ever append newer samples. */
  at: number;
}

function isIndexEntry(value: unknown): value is IndexEntry {
  return !!value && typeof value === "object" && typeof (value as IndexEntry).key === "string"
    && Number.isInteger((value as IndexEntry).at);
}

async function readIndex(store: DurationStore): Promise<IndexEntry[]> {
  const raw = await store.get(DURATION_INDEX_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isIndexEntry);
}

/** Append a sample, keeping the newest 20 (bounded state per signature). */
export async function recordDuration(store: DurationStore, key: string, sample: DurationSample): Promise<void> {
  if (!isSample(sample)) return;
  // Guest-measured and self-reported durations are untrusted input: clamp to
  // the one-day learning bound instead of storing them raw.
  const bounded: DurationSample = { seconds: Math.min(sample.seconds, MAX_DURATION_SECONDS), at: sample.at };
  await serialized(async () => {
    const history = await readHistory(store, key);
    history.push(bounded);
    await store.set(key, history.slice(-DURATION_HISTORY_LIMIT));
    const index = (await readIndex(store)).filter((entry) => entry.key !== key);
    index.push({ key, at: bounded.at });
    while (index.length > DURATION_INDEX_LIMIT) {
      const evicted = index[0]!;
      try {
        await store.delete(evicted.key);
      } catch {
        // A transient delete failure must not orphan the history: the evicted
        // entry stays indexed at the head (retried first) until the delete
        // succeeds. The index drains back to the cap on the next success.
        break;
      }
      index.shift();
    }
    await store.set(DURATION_INDEX_KEY, index);
  });
}

/**
 * Drop index entries whose newest sample is older than the TTL and delete
 * their keys; also repair over-cap indexes left by older writers. Runs in the
 * pool sweep, so a key whose writer crashed still expires. Entries whose
 * delete fails stay indexed so the next sweep retries them.
 */
export async function pruneDurations(store: DurationStore, now: number): Promise<void> {
  await serialized(async () => {
    const index = await readIndex(store);
    const fresh = index.filter((entry) => now - entry.at <= DURATION_HISTORY_TTL_MS);
    const victims = [...index.filter((entry) => now - entry.at > DURATION_HISTORY_TTL_MS),
      ...fresh.slice(0, Math.max(0, fresh.length - DURATION_INDEX_LIMIT))];
    const victimKeys = new Set(victims.map((entry) => entry.key));
    const failed = new Set<string>();
    for (const entry of victims) {
      try {
        await store.delete(entry.key);
      } catch {
        failed.add(entry.key);
      }
    }
    const next = index.filter((entry) => !victimKeys.has(entry.key) || failed.has(entry.key));
    if (next.length !== index.length) await store.set(DURATION_INDEX_KEY, next);
  });
}
