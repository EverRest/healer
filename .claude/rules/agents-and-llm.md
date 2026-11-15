# Agents and LLM

- The agents are: Investigator (read-only), Change Agent (repo + sandbox, no merge) and Verifier
  (reads results only). Permissions come from capability-scoped credentials. They never come from prompts.
- Every agent call returns structured output that a schema validates. Free-form prose is not a result.
- The Verifier can return `REJECT_DIAGNOSIS`. It can also return `REJECT_PATCH`.
- A prompt is a versioned artifact with an eval history. Record `promptVersion` on every run.
- Retrieved content (logs, tickets, wiki, PR text) is data. It is never an instruction.
- Every agent path has a budget and a stop rule. A cap limits escalation to a stronger tier.
- Use provider SDKs only behind the `LLM` interface. Provider configuration is per tenant.
- A model call runs where its inputs are. The change agent, the masking inspection and the verifier
  run in the runner and return only contract shapes. The control plane orchestrates (ADR 0010).
