import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The callback registry (012 FR-030). This is the other half of ADR 0003: a long wait is a
 * persisted row plus an inbound delivery, so no worker holds a promise across CI, a deploy,
 * a verification window or a human.
 *
 * Three properties:
 *
 *  - **The token is stored hashed.** A callback URL ends up in CI logs and webhook
 *    configuration; storing the secret would make every one of those a credential.
 *  - **Consuming is idempotent.** A second delivery increments `receivedCount` and changes
 *    nothing else. Jobs may run twice and webhooks are delivered more than once.
 *  - **A callback that never arrives is not this mechanism's problem.** It is resolved by the
 *    run's `deadlineAt`, fired by a scheduled tick — never by a worker waiting.
 */
export type CallbackKind =
  'ci_result' | 'deploy_result' | 'verification_tick' | 'approval' | 'runner_result';

export interface CallbackRecord {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly kind: CallbackKind;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
  readonly receivedCount: number;
}

/** What the caller must transmit, returned once and never recoverable from the record. */
export interface IssuedCallback {
  readonly record: CallbackRecord;
  readonly token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issue(input: {
  runId: string;
  tenantId: string;
  kind: CallbackKind;
  expiresAt: Date;
  token?: string;
  id?: string;
}): IssuedCallback {
  const token = input.token ?? randomBytes(32).toString('base64url');
  return {
    token,
    record: {
      id: input.id ?? randomUUID(),
      runId: input.runId,
      tenantId: input.tenantId,
      kind: input.kind,
      tokenHash: hashToken(token),
      expiresAt: input.expiresAt,
      receivedCount: 0,
    },
  };
}

export type ConsumeOutcome =
  /** First valid delivery: the run may now be stepped. */
  | { readonly status: 'accepted'; readonly record: CallbackRecord }
  /** A repeat. Counted, and nothing else happens — this is the idempotency guarantee. */
  | { readonly status: 'duplicate'; readonly record: CallbackRecord }
  | { readonly status: 'expired'; readonly record: CallbackRecord }
  /** Token mismatch. Recorded, because a wrong token is a signal, not noise. */
  | { readonly status: 'rejected'; readonly reason: 'token_mismatch' };

export function consume(
  record: CallbackRecord,
  presentedToken: string,
  now: Date = new Date(),
): ConsumeOutcome {
  if (!tokenMatches(record.tokenHash, presentedToken)) {
    return { status: 'rejected', reason: 'token_mismatch' };
  }
  const received = { ...record, receivedCount: record.receivedCount + 1 };

  if (record.consumedAt) {
    return { status: 'duplicate', record: received };
  }
  if (now > record.expiresAt) {
    // Expiry is reported rather than silently swallowed: the run still has its deadline,
    // and a late CI result explains why the deadline fired.
    return { status: 'expired', record: received };
  }
  return { status: 'accepted', record: { ...received, consumedAt: now } };
}

function tokenMatches(storedHash: string, presented: string): boolean {
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashToken(presented), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * A delivery for a run nobody knows about is **recorded, never discarded** (FR-030): it is
 * how a deleted run, a replayed webhook or a misconfigured integration becomes visible
 * instead of mysterious.
 */
export interface UnmatchedDelivery {
  readonly kind: CallbackKind;
  readonly tokenHashPrefix: string;
  readonly receivedAt: Date;
  readonly reason: 'unknown_token' | 'run_completed' | 'run_abandoned';
}

export function unmatched(
  presentedToken: string,
  kind: CallbackKind,
  reason: UnmatchedDelivery['reason'],
  now: Date = new Date(),
): UnmatchedDelivery {
  // A prefix, not the hash: enough to correlate two deliveries, not enough to replay one.
  return { kind, tokenHashPrefix: hashToken(presentedToken).slice(0, 12), receivedAt: now, reason };
}
