import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import type { SignalQueue } from '../../domain/signal-queue.js';
import type { Signal } from '../../domain/signal.js';
import {
  enqueueSignalBatch,
  MAX_SIGNAL_BATCH_SIZE,
  SignalBatchTooLargeError,
} from './enqueue-signal-batch.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000a1');

function signal(component: string): Signal {
  return {
    observedAt: new Date('2026-01-01T00:00:00Z'),
    component,
    environment: 'prod',
    errorSignature: { exceptionType: 'X' },
  };
}

function fakeQueue(): SignalQueue & { batches: unknown[][] } {
  const batches: unknown[][] = [];
  return {
    batches,
    enqueueBatch: (signals) => {
      batches.push([...signals]);
      return Promise.resolve();
    },
  };
}

describe('enqueueSignalBatch (001 T019, FR-019)', () => {
  it('enqueues every signal, scoped to the tenant, in a single batch call, and returns the accepted count', async () => {
    const queue = fakeQueue();
    const accepted = await enqueueSignalBatch(queue, CONTEXT, [signal('a'), signal('b')]);
    expect(accepted).toBe(2);
    // One call for the whole batch, not one call per signal (review finding) — a partial
    // failure must never leave some signals enqueued while the caller sees the request failed.
    expect(queue.batches).toHaveLength(1);
    expect(queue.batches[0]).toHaveLength(2);
    expect(queue.batches[0]?.[0]).toMatchObject({
      tenantId: '00000000-0000-0000-8000-0000000000a1',
      component: 'a',
    });
  });

  it('accepts an empty batch — zero signals is a valid, if pointless, delivery', async () => {
    const queue = fakeQueue();
    expect(await enqueueSignalBatch(queue, CONTEXT, [])).toBe(0);
  });

  it('accepts exactly the maximum batch size', async () => {
    const queue = fakeQueue();
    const batch = Array.from({ length: MAX_SIGNAL_BATCH_SIZE }, (_, i) => signal(`c${i}`));
    expect(await enqueueSignalBatch(queue, CONTEXT, batch)).toBe(MAX_SIGNAL_BATCH_SIZE);
  });

  it('rejects a batch one over the maximum, before enqueuing anything', async () => {
    const queue = fakeQueue();
    const batch = Array.from({ length: MAX_SIGNAL_BATCH_SIZE + 1 }, (_, i) => signal(`c${i}`));
    await expect(enqueueSignalBatch(queue, CONTEXT, batch)).rejects.toBeInstanceOf(
      SignalBatchTooLargeError,
    );
    expect(queue.batches).toHaveLength(0);
  });
});
