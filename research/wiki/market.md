# Market

Everything on this page is a hypothesis until validated. Figures and competitor claims are marked
`(unverified)` and must not be used in pricing or pitch material until checked against primary
sources.

## Which budget line

Healer competes for money currently spent on:

| Budget | Held by | What we displace |
|---|---|---|
| On-call engineering time | Engineering | Context gathering, change correlation, runbook reading |
| Observability tooling | Platform / SRE | Nothing — we sit on top and make it more valuable |
| AI coding assistants | Engineering | Nothing — different moment in the lifecycle |
| Support tooling | Support | Tier-1 answer drafting (AutoSupport) |

The realistic framing is engineering time, not tooling replacement. That matters because it is a
harder budget to access and needs an ROI argument rather than a feature comparison.

## Why incumbents have not done this

Observability vendors own the signals and the incident record, which is most of the context
problem — so the question "why can't Datadog or Grafana do this" needs an answer. The plausible
one: they have the evidence but not the code, the expectation or the change pipeline, and the
verification loop is the hard part rather than the retrieval. **(unverified — needs checking
against what these vendors have shipped recently.)**

AI coding assistants own the code and the change pipeline but see no production signal and carry
no incident state. **(unverified.)**

If either side closes their gap faster than we close ours, the thesis in
[product-thesis](product-thesis.md) weakens.

## Buyer shapes

- **Engineering org, mid-size, high incident load.** Feels the pain nightly, can grant access
  without a six-month security review. Most likely first customers.
- **Platform team at a larger org.** Better budget, far longer procurement, will demand the
  hybrid deployment and BYO model access from the first call.
- **Support organisation.** A different buyer for AutoSupport, with a different sales motion.
  Cross-selling between the two is unproven and should not be assumed.

## Open questions

- Pricing unit: per incident, per component, per seat, per tenant? Unresolved.
- Does the simulator-as-trial motion actually convert? Untested.
- Is diagnosis-only (L1) enough value to sell, or does it read as "expensive summarisation"?
  This is the biggest commercial unknown, and it is testable cheaply with transl8.ai data.
