/** The step that received the shape (001 FR-008) — the only `producedByStep` discovery evidence
 *  ever carries, so "written by the step that received it, never a later one" is one constant
 *  rather than a string a caller could get slightly wrong per call site. */
export const DISCOVERY_EVIDENCE_STEP = 'architecture.discovery';

/**
 * ponytail: 001's retention sweep deletes expired evidence nothing cites through `evidence_link`
 * (001 T052/evidence-retention). A `graph_fact`/`collection_gap` row is cited by
 * `observation_ref` instead, which is not an `evidence_link` — the sweep cannot see that citation
 * and would silently orphan every graph row pointing at an expired fact. Sentinel far-future
 * `expiresAt` until 004 either gives discovery evidence its own retention rule or teaches the
 * sweep about `observation_ref` — **[PAVLO]**, recorded in QUESTIONS.md.
 */
export const DISCOVERY_EVIDENCE_EXPIRES_AT = new Date('9999-12-31T00:00:00.000Z');
