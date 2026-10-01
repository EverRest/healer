import { createHash } from 'node:crypto';
import type { ProposedPayload } from './proposed-payload.js';

/**
 * R-08: moves every re-run, exactly like trace observation volume, so a rejected proposal must
 * not be remembered by a digest that includes them — the digest would never repeat and the
 * rejection would never apply twice (research.md R-08). Deliberately the three names the plan
 * calls out, not a general "strip anything volatile" rule — a closed list is one authority, not a
 * heuristic (AGENTS.md).
 */
const VOLATILE_ATTRIBUTE_KEYS = new Set(['currentVersion', 'lastDeployedAt', 'headSha']);

function omitVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitVolatile);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_ATTRIBUTE_KEYS.has(key)) continue;
    out[key] = omitVolatile(v);
  }
  return out;
}

/** Sorted-key, sorted-primitive-array canonical JSON (plan "proposal_digest"), so two structurally
 *  identical proposals always serialise to the same bytes regardless of build order. Exported for
 *  `graph-fact-id.ts`, which needs the same key-order independence for its own hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    const allPrimitive = value.every((v) => v === null || typeof v !== 'object');
    return `[${(allPrimitive ? [...items].sort() : items).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Structural content only: op, endpoint identities, edge type, layer, normalised attributes
 * (minus the three volatile keys). **Excludes** confidence, strength, provenance, observation
 * counts, first/last observed, window and run id — none of which ever appear on `ProposedPayload`
 * in the first place (they live on `draft_item`'s own columns, not inside `proposed`), so omitting
 * them here is enforced by the input type, not by a field this function has to remember to drop.
 */
export function proposalDigest(proposed: ProposedPayload): string {
  return createHash('sha256')
    .update(canonicalJson(omitVolatile(proposed)))
    .digest('hex');
}
