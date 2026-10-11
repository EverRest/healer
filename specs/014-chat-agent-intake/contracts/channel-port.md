# Contract: `ChatChannel` port and the webhook route

The interface every chat adapter implements (Telegram first, Slack second — FR-020's channel twin,
US6). It names no product; product facts live in the adapter. Declared in
`packages/domain/intake/src/domain/chat-channel.ts`; adapters in
`packages/integrations/src/<platform>/`.

## Port

```ts
interface ChatChannel {
  /** Before any parsing (FR-005). Constant-time comparison of the platform's shared secret. */
  authenticate(headers: Readonly<Record<string, string>>, channel: ChannelConfig): 'authentic' | 'rejected';
  /** A closed event, or `ignored`. Never throws on unknown platform shapes — they are `ignored`. */
  parse(body: unknown, channel: ChannelConfig): ChannelEvent;
  send(chatId: string, message: RenderedMessage): Promise<SendResult>;
  edit(chatId: string, messageId: string, message: RenderedMessage): Promise<SendResult>;
  answerButton(buttonEventId: string, notice?: string): Promise<void>;
  readonly limits: { readonly maxTextLength: number };
}

type SendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'unchanged' }                       // identical content; success
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'gone' }                            // message deleted; send a new one
  | { status: 'failed' };                         // channel_unavailable, retried by the sweep
```

### `ChannelEvent` — closed kinds

| Kind | Carries |
|------|---------|
| `command` | `updateId`, `chatId`, `senderId`, `command`, `argument` (data), `messageId` |
| `reply` | as `command`, plus `repliedToMessageId` |
| `button` | `updateId`, `chatId`, `senderId`, `buttonEventId`, `data` (≤ 64 bytes), `messageId` |
| `finding` | `updateId`, `chatId`, `senderId`, `senderIsBot`, `forwarded`, `text` (data), `messageId` |
| `unclassified` | `updateId`, `chatId`, `senderId`, `messageId` |
| `ignored` | `updateId` and a closed `why`: `edited` · `channel_post` · `other_bot_command` · `unsupported` |

`senderId` is the platform's numeric user id as text, prefixed by the adapter's platform name
(`telegram:123456789`). It is the only identity the allowlist is compared against (FR-004); a name,
a username or anything in the text confers nothing.

### `RenderedMessage`

`text` (≤ `limits.maxTextLength`, already secret-scanned — research R-10) and up to two rows of
buttons, each `{ label, data }` with `data` from the button grammar of
[command-grammar.md](command-grammar.md). No markup the platform would interpret as a link preview of
untrusted content: links are rendered by the adapter from typed references only.

## Webhook route

```text
POST /api/v1/intake/channels/{channelKey}/updates
```

| Step | On failure |
|------|-----------|
| `channelKey` names a configured channel | 404, no body |
| `authenticate` (Telegram: `X-Telegram-Bot-Api-Secret-Token`) | 404, no body, counter `intake_webhook_rejected{reason=secret}` |
| `parse`; `chatId` equals the channel's configured chat | 200, counter `{reason=chat}` — 200 so the platform does not redeliver |
| insert `chat_update_seen` (`ON CONFLICT DO NOTHING`) | duplicate → 200, nothing else (FR-007) |
| sender on the allowlist | 200; audit `intake.refuse` with `sender_not_allowlisted` and the platform user id; no reply (FR-006) |
| classify and act, in the same transaction; enqueue send/render jobs after commit | 5xx → the platform redelivers; the update row rolled back with the work |

The tenant is the channel configuration's (FR-008); no header or body field names it. No external
call happens inside the request: sends, edits, ledger calls and dispatch are queue jobs.

### Channel configuration (control-plane configuration, `packages/shared/src/config`)

`channelKey`, `tenantId`, `platform`, `chatId`, `botUsername`, the secret and the bot token
(secrets, presence-only in diagnostics — research R-11), `allowlist` (non-empty, else the process
refuses to start — FR-004), the executor binding (`repositoryId`, workflow refs), `cardTtlMinutes`
(≤ 60). Absent intake configuration means the intake module is not mounted at all.

## Contract suite (US6 AS1)

One shared suite, run against the fake adapter and every real adapter (the real one against a
recorded fixture server, not the live platform). It names no product. It asserts: a request without
the secret, or with a wrong one, is `rejected`; every fixture update parses to the listed kind and
nothing outside the closed list; an edited message, a channel post and another bot's command are
`ignored`; `send` then `edit` round-trips; identical content is `unchanged`; a rate-limit response
yields `rate_limited` with its delay; `answerButton` is called for every `button` event.
