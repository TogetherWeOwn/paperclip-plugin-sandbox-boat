// Duration learning so only LONG Node/Python commands go remote.
// Per company + repo + profile + normalized command signature, keeps the last
// 20 durations with a 30-day TTL in plugin state. A command is a remote
// candidate only when its recorded median meets the configured threshold;
// unknown signatures run local first and record. Rust keeps its existing
// behaviour and is never gated here.

export interface DurationSample {
  /** Wall-clock seconds for one local or remote run. */
  seconds: number;
  /** Epoch millis when the run finished. */
  at: number;
}

export interface DurationStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const DURATION_HISTORY_LIMIT = 20;
export const DURATION_HISTORY_TTL_MS = 30 * 24 * 60 * 60_000;
const KEY_PREFIX = "offload.duration.v1.";

export function durationKey(repoId: string, profileId: string, signature: string): string {
  return `${KEY_PREFIX}${repoId}\u0000${profileId}\u0000${signature}`;
}

/**
 * Normalized command signature: tool + runner + exact argv. Single-test
 * selections naturally form their own signatures (they stay unknown/local),
 * so no fuzzy normalization that could promote a short command to remote.
 */
export function normalizeSignature(tool: string, runner: string, argv: string[]): string {
  return JSON.stringify([tool, runner, argv]);
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

/** Append a sample, keeping the newest 20 (bounded state per signature). */
export async function recordDuration(store: DurationStore, key: string, sample: DurationSample): Promise<void> {
  if (!isSample(sample)) return;
  const history = await readHistory(store, key);
  history.push(sample);
  await store.set(key, history.slice(-DURATION_HISTORY_LIMIT));
}
