# Contract: command grammar and classification

What a chat post can mean. Classification reads the parsed `ChannelEvent`
([channel-port.md](channel-port.md)) and never the wording of the text (FR-001, research R-15).
Refusal codes are named from [reason-codes.md](reason-codes.md).

## Classification order

The first rule that matches decides. Every rule below runs only after the request is authentic, from
the configured chat, not yet seen, and from an allowlisted sender (FR-004..FR-007); a non-allowlisted
sender stops at `sender_not_allowlisted` before classification.

| # | Event | Becomes |
|---|-------|---------|
| 1 | `button` | the button action below |
| 2 | `reply` to a card or report message the intake sent | stage 3 (follow-up loop); until then `unknown_command` |
| 3 | `command` (a command entity at offset 0, addressed to this bot or to no bot) | the command below |
| 4 | `finding` (forwarded, sent by a bot, or a paste — an attachment or a multi-line block with no leading command) | a `finding` work item (stage 3, FR-003) |
| 5 | anything else | `unclassified`: choice buttons, nothing created (FR-001) |

An edited message, a `channel_post`, and a command addressed to another bot are `ignored`.

## Commands

`<text>` is the rest of the post after the command, trimmed, 1..4000 characters, stored as the work
item's description and passed to an agent only as data (FR-002).

```text
/investigate <text>              → work item `investigate`, state `confirmed`, dispatched at once
/fix #<issue number>             → take the issue (issue_not_found); work item `fix`; card
/fix <text>                      → create an issue labelled `bug`; work item `fix`; card
/task T<3-4 digits>              → read the line on the default branch (task_not_found, task_done,
                                   task_in_flight); take the open issue labelled `agent-task` that
                                   names the identifier, or create one; work item `task`; card
/task <text>                     → create an issue labelled `agent-task`; work item `task`; card
/status                          → the requester's non-terminal work items and the last five
                                   terminal ones, read from the database (FR-029)
/status <short id>               → one work item: state, reason, jobs, links
/cancel                          → the requester's single pending card or running job
                                   (nothing_to_cancel; more than one → argument_invalid with a list)
/cancel <short id>               → that one, if it is the requester's
/help                            → this grammar, rendered
```

A `<short id>` is the first 8 hexadecimal characters of the work item id, unique per tenant among
non-terminal items. Any other command is `unknown_command`; a malformed argument is
`argument_invalid`. `/fix` and `/task` never dispatch: they end at a card (FR-009).

## Buttons

`callback_data` is at most 64 bytes (Telegram). The card id is 16 random bytes, base64url (22
characters), stored only as a SHA-256 hash (data-model.md `card_token_hash`).

```text
c:<card id>                      confirm a card          (card_wrong_account, card_content_changed,
                                                          card_used, card_expired)
x:<card id>                      cancel a card           (same refusals)
w:<work item id, 32 hex>         widen an inconclusive investigation → a new `investigate` item,
                                 parent_id set, next budget tier (US1 AS4)
i:<work item id, 32 hex>         open an issue from an investigation report → issue + `fix` card (US1 AS5)
f:<work item id, 32 hex>         investigate a finding → a new `investigate` item (US5 AS2)
u:<update row id, 32 hex>:<i|f>  choice on an unclassified post: investigate it or record it as a finding
```

Every button press is answered (`answerCallbackQuery`) whatever its outcome, so the client stops
spinning; a refusal is shown on the card and audited.

## What a post can never set

The prompt, the task identifier, the protected-path list, the budget, the labels and the grant come
from the work item's typed fields, the registered prompt and policy — never from `<text>` (FR-002,
FR-011, SC-002). There is no command that requests a merge, an approval or an administration action,
and none can be added without editing this contract.
