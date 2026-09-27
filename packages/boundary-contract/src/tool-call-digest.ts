import { createHash } from 'node:crypto';

/**
 * Tool call arguments cross as a digest, never the value (012 T059, FR-033). Arguments
 * routinely contain file paths, identifiers and excerpts, and `agent_run` — recorded here,
 * read by support — has no shape that can carry them (data-model.md "Self-observation").
 * `RunnerEvidence`'s `agentRunReport.toolCalls[].argumentDigest` (index.ts) already makes the raw
 * value unrepresentable in the crossing shape; this is what computes the digest it carries.
 */

// Recursively sorts object keys so two calls with the same arguments in a different key order
// hash identically — JSON.stringify's own key-order replacer only reaches the top level.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonicalize(v)]),
    );
  }
  return value;
}

export function digestToolCallArguments(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args)))
    .digest('hex');
}
