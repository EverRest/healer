declare const humanActorBrand: unique symbol;

/**
 * The named human behind an adoption (FR-010, R-02). A branded type: an `ExpectationAdopted`
 * payload cannot carry a bare string, so adopting without explicitly constructing a human actor is
 * not expressible. Today the factory only refuses an empty ref; T026 adds the check that the ref is
 * not Healer's own service identity here, which is why every adoption path must come through it.
 */
export type HumanActorRef = string & { readonly [humanActorBrand]: 'HumanActorRef' };

export function humanActorRef(raw: string): HumanActorRef {
  if (raw.trim() === '') throw new Error('a human actor ref must be non-empty');
  return raw as HumanActorRef;
}
