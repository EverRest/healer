# Security and tenancy

- `tenantId` is mandatory in every query and every retrieval. Enforce it in the query layer.
  Never take it from a request body. Never filter it after the query.
- The sandbox denies network egress by default. It holds no production credentials.
- No agent gets raw shell access. Tools are declared and schema-validated. The system audits each call.
- Only structured evidence crosses the control/execution boundary: normalized error signatures,
  trace shapes, metric deltas, file paths and test results. Never send raw log bodies. Never send
  source or patch content. Never send the model input or output of a runner-side agent (ADR 0010).
- Healer never sends customer-facing text. AutoSupport proposes. Something else sends.
- Put no secrets in logs, traces or evidence records.
