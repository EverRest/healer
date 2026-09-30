import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.js';
import type { DecisionInput } from './decision-input.js';

// T021: `policy_decision.proposal_digest` — "canonical hash of the DecisionInput; a decision is
// valid for this digest only" (data-model.md). `canonicalize` (shared with `policy-ruleset.ts`'s
// ruleset digest, factored out after review) recursively sorts object keys so two structurally
// identical `DecisionInput`s hash identically regardless of the key order a caller happened to
// build the object literal in.
export function computeProposalDigest(input: DecisionInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}
