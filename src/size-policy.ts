import { BoatProviderError } from "./errors.js";

export const BOAT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type BoatSize = (typeof BOAT_SIZES)[number];

// List prices are the fallback for usage accounting, not substitutes for measurements.
export const PRICE_PER_HOUR: Record<BoatSize, number> = {
  small: 0.018,
  default: 0.036,
  large: 0.072,
  xlarge: 0.2,
};

export interface SizeMeasurement {
  durationSeconds: number;
  hourlyRate: number;
  measuredAt: string;
  sampleCount: number;
}
export type SizeCostTable = Record<string, Partial<Record<BoatSize, SizeMeasurement>>>;
export interface SizeChoice {
  taskClass: string;
  size: BoatSize;
  source: "measured" | "fallback" | "running_vm";
  expectedCostDollars: number | null;
  durationSeconds: number | null;
  measuredAt: string | null;
  sampleCount: number;
}

function invalid(detail: string): never {
  throw new BoatProviderError("BOAT_SIZE_POLICY_INVALID", `sizeCostTable/taskClass: ${detail}. Update the environment's measured size policy; no VM was started.`);
}

export function parseTaskClass(value: unknown, fallback = "default"): string {
  if (value == null) return fallback;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    invalid("task classes must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  }
  return value;
}

export function isBoatSize(value: unknown): value is BoatSize {
  return typeof value === "string" && (BOAT_SIZES as readonly string[]).includes(value);
}

export function requireBoatSize(value: unknown): BoatSize {
  if (isBoatSize(value)) return value;
  throw new BoatProviderError("BOAT_SIZE_UNKNOWN", "boat did not report a supported VM size; refusing to guess its accounting or plan eligibility. Update the plugin's supported sizes or retry after the VM is archived.");
}

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function costPerJob(measurement: Pick<SizeMeasurement, "hourlyRate" | "durationSeconds">): number {
  return measurement.hourlyRate * measurement.durationSeconds / 3600;
}

export function parseSizeCostTable(value: unknown): SizeCostTable {
  if (value == null) return {};
  if (!object(value)) invalid("expected an object keyed by task class");
  const table: SizeCostTable = Object.create(null);
  for (const [taskClass, sizes] of Object.entries(value)) {
    parseTaskClass(taskClass);
    if (!object(sizes)) invalid(`class ${taskClass} must contain measurements keyed by size`);
    const measurements: Partial<Record<BoatSize, SizeMeasurement>> = {};
    for (const [size, raw] of Object.entries(sizes)) {
      if (!isBoatSize(size)) invalid(`unknown size in class ${taskClass}`);
      if (!object(raw)) invalid(`class ${taskClass}/${size} must be a measurement object`);
      const { durationSeconds, hourlyRate, measuredAt } = raw;
      const sampleCount = raw.sampleCount ?? 1;
      if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
          typeof hourlyRate !== "number" || !Number.isFinite(hourlyRate) || hourlyRate <= 0 ||
          typeof sampleCount !== "number" || !Number.isSafeInteger(sampleCount) || sampleCount < 1 ||
          typeof measuredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(measuredAt) || !Number.isFinite(Date.parse(measuredAt))) {
        invalid(`class ${taskClass}/${size} needs positive finite durationSeconds and hourlyRate, an ISO measuredAt, and a positive integer sampleCount`);
      }
      const measurement = { durationSeconds, hourlyRate, measuredAt, sampleCount };
      const cost = costPerJob(measurement);
      if (!Number.isFinite(cost) || cost <= 0) invalid(`class ${taskClass}/${size} produces an invalid cost`);
      measurements[size] = measurement;
    }
    table[taskClass] = measurements;
  }
  return table;
}

/** Rebuild the table from individual completed pilot jobs in the trailing week. */
export function recomputeSizeCostTable(samples: unknown[], nowMs: number): SizeCostTable {
  if (!Number.isFinite(nowMs)) invalid("refresh time must be a valid timestamp");
  const groups = new Map<string, { taskClass: string; size: BoatSize; seconds: number; dollars: number; count: number; measuredAt: string }>();
  for (const sample of samples) {
    if (!object(sample)) invalid("each pilot log row must be an object");
    if (sample.status === "failed") continue;
    if (sample.status !== "completed") invalid("each pilot log row needs status completed or failed");
    const taskClass = parseTaskClass(sample.taskClass);
    if (sample.taskClass == null || !isBoatSize(sample.size)) invalid("completed log rows need taskClass and size");
    const size = sample.size;
    const measurement = parseSizeCostTable({ [taskClass]: { [size]: { ...sample, sampleCount: 1 } } })[taskClass][size]!;
    const at = Date.parse(measurement.measuredAt);
    if (at > nowMs) invalid("completed log row is future-dated; check the timestamp or refresh time");
    if (at < nowMs - 7 * 24 * 3600 * 1000) continue;
    const key = `${taskClass}\u0000${size}`;
    const group = groups.get(key) ?? { taskClass, size, seconds: 0, dollars: 0, count: 0, measuredAt: measurement.measuredAt };
    group.seconds += measurement.durationSeconds;
    group.dollars += costPerJob(measurement);
    group.count += 1;
    if (at > Date.parse(group.measuredAt)) group.measuredAt = measurement.measuredAt;
    groups.set(key, group);
  }
  const table: SizeCostTable = Object.create(null);
  for (const group of groups.values()) {
    const sizes = table[group.taskClass] ??= {};
    // Duration-weighted effective rate preserves mean cost when rates changed.
    sizes[group.size] = {
      durationSeconds: group.seconds / group.count,
      hourlyRate: group.dollars * 3600 / group.seconds,
      measuredAt: group.measuredAt,
      sampleCount: group.count,
    };
  }
  return parseSizeCostTable(table);
}

export function selectSize(
  config: { taskClass: string; size: BoatSize; sizeCostTable: SizeCostTable },
  taskClass = config.taskClass,
  runningSize?: BoatSize,
): SizeChoice {
  const measurements = Object.hasOwn(config.sizeCostTable, taskClass) ? config.sizeCostTable[taskClass] : {};
  let size = config.size;
  let best: SizeMeasurement | undefined;
  for (const candidate of BOAT_SIZES) {
    const measurement = measurements[candidate];
    if (!measurement) continue;
    const cost = costPerJob(measurement);
    const bestCost = best ? costPerJob(best) : Infinity;
    const tied = best && Math.abs(cost - bestCost) <= Math.max(cost, bestCost) * Number.EPSILON * 8;
    if (!best || (tied ? measurement.durationSeconds < best.durationSeconds : cost < bestCost)) {
      size = candidate;
      best = measurement;
    }
  }
  const source = runningSize && runningSize !== size ? "running_vm" : best ? "measured" : "fallback";
  if (runningSize) {
    size = runningSize;
    best = measurements[size];
  }
  return {
    taskClass, size, source,
    expectedCostDollars: best ? costPerJob(best) : null,
    durationSeconds: best?.durationSeconds ?? null,
    measuredAt: best?.measuredAt ?? null,
    sampleCount: best?.sampleCount ?? 0,
  };
}
