import { createHash } from 'node:crypto';
import { canonicalJson } from './proposal-digest.js';

/**
 * Deterministic evidence id for a discovery-received shape (plan "Evidence for discovery"):
 * `sha256(tenantId|runId|kind|canonicalJSON(shape))`, UUID-formatted. Pure — the diff-builder
 * computes the same id a draft item's `observation_ref` carries without a database round trip,
 * and a retried ingest of the same batch computes the identical id, which is what makes
 * `createMany({ skipDuplicates: true })` collapse a retry instead of duplicating evidence.
 * Canonical (sorted-key) JSON, not plain `JSON.stringify` — a zod-parsed object's key order is not
 * guaranteed to be stable across an otherwise-identical retry.
 */
export function graphFactId(tenantId: string, runId: string, kind: string, shape: unknown): string {
  const hex = createHash('sha256')
    .update(`${tenantId}|${runId}|${kind}|${canonicalJson(shape)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
