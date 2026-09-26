# Evidence and policy

- `Evidence` is immutable, append-only, typed, timestamped, with source and provenance.
- A step writes evidence links only about itself. Reconstructing links afterwards is forbidden.
- Verification anchors: adopted `ExpectedBehavior`, raw evidence, human-written tests, production
  signal. Nothing else.
- Machine-generated knowledge never becomes an `ExpectedBehavior` without explicit human adoption.
- Source trust inverts by question — "what does it do" vs "what should it do" (constitution).
- Every mutation passes the Policy Engine; every decision is written to the audit trail.
- Policy is deterministic and versioned; model output cannot override it.
