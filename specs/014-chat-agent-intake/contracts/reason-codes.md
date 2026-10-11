# Contract: intake reason codes

**The one authority for FR-028.** Every refusal and failure the intake produces carries exactly one
code from the fenced block below. Other documents name a code; none restates the list. The domain
package's `REASON_CODES` constant is pinned to this block by a test that parses it — the same way
`gate-agent-scope` reads the protected-path block of 012's make-targets contract rather than holding
a copy. Adding a code is an edit here first.

Policy refusals are **not** expanded here: they carry `policy_denied` plus 002's own reason code in
`work_item.policy_reason_code`; 002's `reason-code.ts` stays the authority for those.

```text
# code                    shown in channel   where it arises
sender_not_allowlisted    no (audit only)    FR-004, FR-006
chat_not_configured       no (counted)       FR-005 — a configured channel, a foreign chat id
unknown_command           yes                command grammar
argument_invalid          yes                command grammar
issue_not_found           yes                /fix #n — the ledger has no such issue
task_not_found            yes                /task Tn — no such line in tasks.md on the default branch
task_done                 yes                /task Tn — the line is ticked
task_in_flight            yes                /task Tn — a non-terminal work item holds it
work_item_busy            yes                FR-015 — a job is already running for it
nothing_to_cancel         yes                /cancel with no own pending or running item
card_wrong_account        yes                FR-010
card_content_changed      yes                FR-010
card_used                 yes                FR-010 — a second confirmation; idempotent, no second job
card_expired              yes                FR-010 — also the work item's `expired` reason
policy_denied             yes                FR-012 — with 002's code alongside
concurrency_cap           yes                FR-012 — per-tenant running-job cap (research R-08)
dispatch_failed           yes                US4 AS1 — host refused or unreachable after retries
timeout                   yes                FR-019
run_cancelled_on_host     yes                the run was cancelled or re-run outside Healer
cancelled_by_owner        yes                FR-032
budget_exhausted          yes                FR-027 — outcome `stopped`, breach recorded
report_invalid            yes                the `ended` payload failed its schema
report_withheld_secret    yes                FR-025 — the work item's state is unaffected
callback_refused          no (audit only)    FR-017 — bad or foreign identity token
channel_unavailable       no (on /status)    FR-029 — a failed send or edit, retried
```
