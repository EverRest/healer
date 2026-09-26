# Security and tenancy

- `tenantId` is mandatory in every query and every retrieval, enforced at the query layer.
  Never from a request body, never by post-filtering.
- The sandbox has default-deny network egress and holds no production credentials.
- No agent gets raw shell access; tools are declared, schema-validated and audited per call.
- What crosses the control/execution boundary: structured evidence only — normalised error
  signatures, trace shapes, metric deltas, file paths, test results. Never raw log bodies, never
  source or patch content, never a runner-side agent's model input or output (ADR 0010).
- Customer-facing text is never sent by Healer; AutoSupport proposes, something else sends.
- No secrets in logs, traces or evidence records.
