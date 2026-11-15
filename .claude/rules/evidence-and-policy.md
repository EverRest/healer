# Evidence and policy

- `Evidence` is immutable, append-only, typed and timestamped. It has a source and provenance.
- A step writes evidence links only about itself. Do not rebuild links afterwards.
- The verification anchors are: an adopted `ExpectedBehavior`, raw evidence, human-written tests and
  production signal. There are no other anchors.
- Machine-generated knowledge never becomes an `ExpectedBehavior` unless a human adopts it explicitly.
- Source trust inverts with the question: "what does it do" or "what should it do" (constitution).
- Every mutation passes the Policy Engine. The system writes every decision to the audit trail.
- Policy is deterministic and versioned. Model output cannot override it.
