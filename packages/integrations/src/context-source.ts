import type { CollectorKey } from '@healer/boundary-contract';

/**
 * The read side of a context source (003 T005, FR-002): the client for a customer system, bound to
 * credentials that exist only in the execution plane. An adapter returns **unvalidated records** —
 * the runner's collector parses them with its own schema, because whatever a customer system
 * answers is untrusted until then — and it only ever reads (read-only capability, 012 C-02).
 *
 * The v1 set is the constitution's adapter table and nothing beyond it: a source the design partner
 * does not operate is absent from the plan, not a failing collector (spec assumptions).
 */
export interface ContextSourceRequest {
  readonly component: string;
  readonly environment: string;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly limit: number;
  /** Named repository-relative paths — only the follow-up `source_file` read sets this. */
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ContextSourceAdapter {
  readonly key: string;
  readonly version: string;
  /** The declared collectors this adapter can serve — members of the boundary's closed list. */
  readonly collectorKeys: readonly CollectorKey[];
  read(collectorKey: CollectorKey, request: ContextSourceRequest): Promise<readonly unknown[]>;
}

/**
 * A skeleton: it honours cancellation and returns nothing, exactly as the discovery skeletons of
 * 004 did before their real I/O landed. The real client replaces `read`; the key, version and the
 * collectors served are the part reviewers check.
 */
export function skeletonContextSource(
  key: string,
  collectorKeys: readonly CollectorKey[],
): ContextSourceAdapter {
  const adapter: ContextSourceAdapter = {
    key,
    version: '0.1.0',
    collectorKeys,
    async read(collectorKey, request) {
      request.signal?.throwIfAborted();
      if (!collectorKeys.includes(collectorKey)) {
        throw new Error(`${key} does not serve ${collectorKey}`);
      }
      return [];
    },
  };
  return Object.freeze(adapter);
}
