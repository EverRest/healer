# Operating Healer

How Healer is observed and supported in production — its own control plane, and the runners it ships
into customers' networks. Requirements are in 012 (FR-032..FR-037, US4, US6), decisions in C-41; this
page is the reasoning.

## Logs are not the debugging tool

In production nobody reads Healer's logs to understand a decision. Every decision is a row: workflow
transitions with their cause, `agent_run` with model, prompt version, tokens, cost and tool calls, audit
entries, policy decisions. "Why did Healer propose this patch?" is a query by correlation identifier over
those tables, and the same records answer a customer's change-management reviewer (012 US6).

The rule that follows: **if answering a question needs a log line, that fact should have been a row.**
Logs are for infrastructure — a connection refused, a process restarted — not for product decisions.

## Two planes, two support models

| | Control plane (ours) | Runner (customer's network) |
|---|---|---|
| What we can see | everything: rows, traces, logs, metrics | registration, heartbeats, capability resolutions, ingress rejections, the diagnostic bundle |
| What we cannot see | — | log bodies, source, payloads, environment, anything withheld |
| Debugging model | query the state, then traces | the bundle, by design ([runbook](../../docs/runbooks/runner-diagnosis.md)) |

Blind support is a product constraint, not a limitation to apologise for. Asking a customer for logs
would be the first crack in the boundary the whole security posture rests on. It forces every runner
error to have a normalised signature — text stays with the customer, the code comes to us.

## Where telemetry goes

One OpenTelemetry Collector per deployment exports traces, logs and metrics to Grafana Cloud (C-41).
Code exports only through the collector, so moving to a self-hosted Grafana, Loki, Tempo and Prometheus
under Docker Compose is a configuration change. That move is planned, not rejected; its triggers are the
first enterprise review that wants telemetry kept in our infrastructure, or the bill exceeding the cost of
running the stack ourselves.

Before export the tenant identifier is replaced by a keyed hash. A hosted backend cannot audit per-tenant
reads for us, and 012 FR-037 requires operator access to a tenant's telemetry to be audited — so the
telemetry does not name tenants, and the only way from a hash to a tenant is an application read that
writes its own audit entry.

## Alert on state, not on text

Alerts fire on facts that mean something is stuck or expensive:

- a workflow past its declared budget
- dead-letter depth growing in any queue class
- the rate of `timeout` transitions
- cost per issue, from `agent_run` — the same source budgets read (012 FR-036)
- a runner's heartbeat gap

An alert on an error-log pattern is an alert on prose, and prose changes when someone edits a message.

## Redaction happens at emission

Secrets and customer content are removed where a log line or span is created (012 FR-035), not in the
collector or the backend. A pipeline that redacts downstream has already carried the secret through
every hop before it.
