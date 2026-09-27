import { createHash, randomUUID } from 'node:crypto';

/**
 * The prompt registry (012 T063, T064, R-07, FR-038, FR-039). An audit entry from a year ago
 * must resolve to the exact prompt text, so there is no update path: republishing identical
 * content is a no-op, changed content is a new version, and this module exports no function
 * that could mutate an existing one — "no update path" is what's missing from the surface, not a
 * check that runs and rejects.
 *
 * Runtime resolves by version identifier only, never by key: resolving by name would let an old
 * audit entry start pointing at new text the day someone republishes. `resolveByVersionId` is the
 * only resolver this module exports; there is no `resolveByKey`.
 */
export interface PublishedPromptVersion {
  readonly id: string;
  readonly key: string;
  readonly digest: string;
  readonly body: string;
  readonly schemaRef?: string;
  readonly publishedAt: Date;
  readonly publishedBy: string;
}

export interface PublishInput {
  readonly key: string;
  readonly body: string;
  readonly schemaRef?: string;
  readonly publishedBy: string;
}

export type PublishResult =
  | { readonly outcome: 'no-op'; readonly version: PublishedPromptVersion }
  | { readonly outcome: 'published'; readonly version: PublishedPromptVersion };

export function computePromptDigest(body: string, schemaRef?: string): string {
  return createHash('sha256')
    .update(body)
    .update(schemaRef ?? '')
    .digest('hex');
}

/**
 * `existingVersionsForKey` is supplied by the caller — this module holds no store of its own,
 * so there is exactly one store of published prompts (the caller's repository), never two.
 */
export function publish(
  input: PublishInput,
  existingVersionsForKey: readonly PublishedPromptVersion[],
  deps: { now?: Date; generateId?: () => string } = {},
): PublishResult {
  const digest = computePromptDigest(input.body, input.schemaRef);
  const identical = existingVersionsForKey.find((v) => v.digest === digest);
  if (identical) return { outcome: 'no-op', version: identical };

  return {
    outcome: 'published',
    version: {
      id: (deps.generateId ?? randomUUID)(),
      key: input.key,
      digest,
      body: input.body,
      ...(input.schemaRef !== undefined ? { schemaRef: input.schemaRef } : {}),
      publishedAt: deps.now ?? new Date(),
      publishedBy: input.publishedBy,
    },
  };
}

/** The only resolver. There is deliberately no `resolveByKey` (see the module doc comment). */
export function resolveByVersionId(
  id: string,
  versions: readonly PublishedPromptVersion[],
): PublishedPromptVersion | undefined {
  return versions.find((v) => v.id === id);
}
