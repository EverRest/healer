import { z } from 'zod';
import type { Collector, SourcePort } from './types.js';
import { isoTimestamp, parseRecords } from './helpers.js';

// `message` and `diff` may be present on what the source returns; this schema does not name them,
// so they are never read — commit metadata and changed paths only (FR-007, FR-011).
const rawCommit = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  authorHandle: z.string().min(1),
  committedAt: isoTimestamp,
  changedPaths: z.array(z.string().regex(/^[\w@$.+/-]{1,300}$/)).max(200),
  locator: z.string(),
});

/** `gitlab_commits` (003 T025, quickstart 5): sha, author handle, time, changed paths — not diff content. */
export function gitlabCommitsCollector(source: SourcePort): Collector {
  return {
    key: 'gitlab_commits',
    async collect(invocation, ctx) {
      const { component, environment } = invocation.parameters as {
        component: string;
        environment: string;
      };
      const records = await source.read({
        component,
        environment,
        window: ctx.window,
        limit: ctx.maxItems + 1,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const { parsed, unrecognised } = parseRecords(rawCommit, records, 'commit_ref', ctx);
      return {
        candidates: [
          ...unrecognised,
          ...parsed.slice(0, ctx.maxItems).map((c) => ({
            kind: 'candidate' as const,
            itemClass: 'commit_ref' as const,
            evidence: {
              kind: 'commit_ref' as const,
              sha: c.sha,
              authorHandle: c.authorHandle,
              occurredAt: c.committedAt,
              changedPaths: c.changedPaths,
            },
            observedAt: new Date(c.committedAt),
            sourceLocator: c.locator,
          })),
        ],
        capped: parsed.length > ctx.maxItems,
      };
    },
  };
}
