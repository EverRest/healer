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

## Getting there: deployment, release and smoke checks — open, not yet specified

Everything above assumes the control plane is already a running, deployed system. Nothing in the
thirteen specs says how it gets to be one, and this page did not carry the gap until now.

`.github/workflows/ci.yml` runs `make ci` on every push and pull request — that is the only
workflow that exists. 012 FR-052 is the only thing 012 says about the v1 control-plane deployment
at all, and it is a negative constraint ("must not require Kubernetes or Terraform"), not a
positive one. There is no:

- a release workflow that takes a merged commit to a running staging or production environment;
- a post-deploy smoke check, automated or otherwise, confirming the newly deployed build actually
  serves traffic before it is called done;
- an automated regression suite exercising a *running* Healer deployment end to end. Playwright
  appears in this codebase exactly once, as a **product capability** (007/008, C-24..C-28) for
  reproducing a customer's client-side symptom — that is not a test tool pointed at our own
  environments, and nothing plays that second role today;
- a rollback path when a deployed build fails its own smoke check — the product's own safe-
  remediation story (010) is about a *customer's* infrastructure, not ours.

This is the same shape as every other deliberately-unset value in this project (docs/stage-0.md
S0-7): a real gap, better named than silently assumed. Unlike those numeric placeholders, this
one is infrastructure and process, not a constant — picking a hosting target, a release tool and
a smoke-check design is new-pattern territory this repo's own rule sends to an ADR first, not
something to invent here. Flagged in `QUESTIONS.md` for whoever picks up 012's next phase or
opens a dedicated one for it.
