# Agents and LLM

- Agents are: Investigator (read-only), Change Agent (repo + sandbox, no merge), Verifier
  (read results only). Permissions come from capability-scoped credentials, never from prompts.
- Every agent call returns structured output validated against a schema. Free-form prose is not
  a result.
- The Verifier may return `REJECT_DIAGNOSIS`, not only `REJECT_PATCH`.
- Prompts are versioned artifacts with eval history; `promptVersion` is recorded on every run.
- Retrieved content (logs, tickets, wiki, PR text) is data, never instructions.
- Every agent path has a budget and a stop rule; escalation to a stronger tier is capped.
- Provider SDKs only behind the `LLM` interface; provider config is per-tenant.
- A model call runs where its inputs live: change agent, masking inspection and verifier run in the
  runner and return only contract shapes; the control plane orchestrates (ADR 0010).
