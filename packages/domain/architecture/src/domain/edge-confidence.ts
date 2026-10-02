import type { MachineProvenanceClass } from './edge-observation.js';

/**
 * R-15 (FR-006): `min(100, base + observation_term - staleness_term)`, clamped at 0, every term an
 * integer — a float sum is not byte-reproducible across platforms, and a confidence that differs
 * between two machines makes a policy decision non-deterministic. Computed at write time only: it
 * is never recomputed on a schedule (a pinned query, FR-014/SC-005, could not reproduce it).
 *
 * Constants are per-tenant configuration with these starting values (tuned once discovery
 * accuracy is measured, stage 0 S0-4). `base` covers the machine classes only: the human classes
 * never reach the observation merge path (see `EdgeObservation`).
 */
export interface ConfidenceConfig {
  readonly base: Readonly<Record<MachineProvenanceClass, number>>;
  /** Points per doubling of observation volume. */
  readonly observationScale: number;
  readonly observationCap: number;
  /** Points lost per complete 30-day period since the last supporting observation. */
  readonly stalenessPerPeriod: number;
  readonly stalenessCap: number;
  /** Ceiling when volume is 1: one observation is an observation, not a fact. */
  readonly singleObservationCap: number;
}

export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceConfig = {
  base: {
    derived_from_trace: 70,
    derived_from_runtime: 65,
    derived_from_code: 60,
    derived_from_config: 50,
    inferred_from_convention: 20,
  },
  observationScale: 4,
  observationCap: 20,
  stalenessPerPeriod: 5,
  stalenessCap: 40,
  singleObservationCap: 40,
};

/** Deliberately has no `confidence` field: a model's self-report is not an input. */
export interface ConfidenceInput {
  readonly provenance: MachineProvenanceClass;
  readonly observationCount: number;
  readonly lastObservedAt: Date;
}

const DAY_MS = 86_400_000;
const PERIOD_DAYS = 30;
const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function deriveEdgeConfidence(
  input: ConfidenceInput,
  now: Date,
  config: ConfidenceConfig = DEFAULT_CONFIDENCE_CONFIG,
): number {
  const volume = Math.max(0, Math.floor(input.observationCount));
  // floor(log2(1 + volume)) by bit length — exact integer arithmetic, no Math.log2.
  const doublings = volume >= 2 ** 31 - 1 ? 31 : 31 - Math.clz32(1 + volume);
  const observationTerm = Math.min(config.observationCap, config.observationScale * doublings);
  const idleDays = Math.max(
    0,
    Math.floor((now.getTime() - input.lastObservedAt.getTime()) / DAY_MS),
  );
  const stalenessTerm = Math.min(
    config.stalenessCap,
    config.stalenessPerPeriod * Math.floor(idleDays / PERIOD_DAYS),
  );
  const score = clamp(config.base[input.provenance] + observationTerm - stalenessTerm);
  return volume <= 1 ? Math.min(score, config.singleObservationCap) : score;
}

const SCALARS = [
  'observationScale',
  'observationCap',
  'stalenessPerPeriod',
  'stalenessCap',
  'singleObservationCap',
] as const;

const isInt0to100 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;

/**
 * A tenant's stored override (jsonb, so `unknown`) laid over the default. Anything that is not a
 * known key holding an integer 0-100 throws: a typo'd or out-of-range knob silently falling back
 * to the default would make a tenant's configuration a lie.
 */
export function resolveConfidenceConfig(override: unknown): ConfidenceConfig {
  if (override === null || override === undefined) return DEFAULT_CONFIDENCE_CONFIG;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('confidence configuration must be an object');
  }
  const { base, ...scalars } = override as Record<string, unknown>;
  const known = new Set<string>(SCALARS);
  const unknownKey = Object.keys(scalars).find((k) => !known.has(k));
  if (unknownKey !== undefined) throw new Error(`unknown confidence setting: ${unknownKey}`);

  const baseOverride = (base ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(baseOverride)) {
    if (!(key in DEFAULT_CONFIDENCE_CONFIG.base))
      throw new Error(`unknown provenance class: ${key}`);
    if (!isInt0to100(value)) throw new Error(`confidence base for ${key} must be an integer 0-100`);
  }
  for (const key of SCALARS) {
    if (key in scalars && !isInt0to100(scalars[key])) {
      throw new Error(`${key} must be an integer 0-100`);
    }
  }
  return {
    ...DEFAULT_CONFIDENCE_CONFIG,
    ...(scalars as Partial<ConfidenceConfig>),
    base: {
      ...DEFAULT_CONFIDENCE_CONFIG.base,
      ...(baseOverride as Partial<ConfidenceConfig['base']>),
    },
  };
}
