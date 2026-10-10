# Runbook: rotating a tenant's model-provider key

Runner-side inference (ADR 0010) means the key that pays for a tenant's model calls lives in the
**customer's** secret manager, not in Healer. Rotation is therefore a hand-off between two parties, and
the one rule that makes it safe is the order: **the new key works before the old one dies.**

No credential is ever sent over the runner protocol (`contracts/runner-protocol.md`, "Runner-side
inference"): not in a directive, not in a heartbeat reply, not in a message to support. If a step below
seems to need one to travel through Healer, stop — that step is wrong.

## Which key is this?

| Tenant mode | Whose key | Who issues the new one | Who revokes the old one |
|-------------|-----------|------------------------|-------------------------|
| `healer_provided` | Per-tenant, spend-limited key issued by Healer (C-34) | Healer | Healer |
| `customer_byo` | The customer's own provider account | The customer | The customer |

There is no shared key and no Healer inference proxy, so one tenant's rotation never touches another's.
For `customer_byo`, Healer holds no key and never will; the sections below that say "Healer issues" do
not apply, and Healer must never fall back to a Healer-provided key if the customer's key fails (FR-046,
the check behind T070).

## When to rotate

- On a schedule the customer's policy sets.
- On suspected exposure — **revoke immediately instead; skip the overlap window** and accept that agent
  directives are refused for that tenant until the new key is stored. A leaked key outranks availability.
- Before an offboarded person who could read the secret manager loses access.

## Procedure

1. **Issue the new key.** `healer_provided`: create a new per-tenant key at the provider with the same
   spend limit as the old one (the limit is the hard budget stop — a key without it breaks the
   guarantee). Name it with the tenant and the issue date so the old and new key are told apart.
2. **Customer stores it.** The customer puts the new key in their secret manager under the *new* secret
   version. Healer's side of the hand-off is the out-of-band delivery channel agreed at onboarding, never
   chat, a ticket or the runner protocol.
3. **Overlap window.** Both keys are valid. The runner resolves its credential from the secret manager
   at the start of each agent directive, so it picks up the new version on the **next directive** — there
   is no restart and no control-plane message. Keep the overlap at least as long as the longest agent
   wall-clock budget (an in-flight run holds the old key until it ends).
4. **Confirm the new key is in use.** Check provider usage for the new key shows a run after the switch,
   and that the old key shows none. Also check the tenant's recent `agent_run` rows: `executed_in = runner`,
   outcomes not failing with a provider authentication error.
5. **Revoke the old key** at the provider. Only after step 4.
6. **Record it.** Add an `audit_entry` for the rotation (actor, tenant, key identifiers — never key
   material).

## What each failure means

| Symptom | Meaning | Action |
|---------|---------|--------|
| Runs fail with provider authentication errors after step 3 | The runner still resolves the old version, or the new secret was stored under the wrong name | Fix the secret reference in the customer's secret manager; do **not** re-issue a key to "try again" |
| Runs fail after step 5 | Step 4 was skipped and something still used the old key | Restore the old key if the provider allows it, else store the new one and re-run |
| A directive is refused with `inference_capability_missing` | The runner image does not declare `inference` | Not a key problem — see [runner-diagnosis.md](runner-diagnosis.md) |
| Spend stops at the key limit while Healer's budget shows headroom | The key's own limit is the hard stop (ADR 0010); Healer's budget is the policy stop | Raise the key's limit deliberately, or wait for the period to roll over |
| Reported cost and the provider's bill disagree | Reported cost is recorded as reported; reconciliation against provider usage per key is not yet built (012 T094) | Compare by hand using the key identifier; do not edit `agent_run` |

## Status of the machinery this relies on

Honest about what exists today: secret-manager integration (T066) and per-tenant provider resolution
(T067) are **deferred**, so "the runner re-resolves on the next directive" is the contract's requirement,
not yet a behaviour of the code. Until they land, steps 2–3 describe the intended hand-off and the
runner has no credential source to rotate.
