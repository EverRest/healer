/** Closed provenance set (FR-005). Strength ordinals and confidence scoring are T007/R-15's job. */
export type ProvenanceClass =
  | 'human_authored'
  | 'human_confirmed'
  | 'derived_from_trace'
  | 'derived_from_runtime'
  | 'derived_from_code'
  | 'derived_from_config'
  | 'inferred_from_convention';

export type GraphLayer = 'code' | 'runtime' | 'product';
