import { z } from 'zod';
import { repoRelativePath } from '@healer/boundary-contract';
import type { Collector, SourcePort } from './types.js';
import { parseRecords } from './helpers.js';

// `content` may be present on what the source returns; it is not named here and so is never read.
const rawFile = z.object({
  path: repoRelativePath,
  exists: z.boolean(),
  locator: z.string(),
});

/**
 * `source_file` (003 T026, FR-011, R-12): named-file retrieval is a collector like any other and is
 * reachable **only as a follow-up pass** — the boundary schema refuses it in pass 0
 * (`checkCollectionPlan`) — so it inherits the follow-up cap, the schema validation and the audit
 * entry instead of being a second mechanism. What crosses is the repository-relative path of a file
 * that exists; the closed shape set has no file-content shape, so no content crosses (open
 * cross-spec item, recorded in QUESTIONS.md).
 */
export function sourceFileCollector(source: SourcePort): Collector {
  return {
    key: 'source_file',
    async collect(invocation, ctx) {
      const { paths } = invocation.parameters as { paths: string[] };
      const records = await source.read({
        component: '',
        environment: '',
        window: ctx.window,
        limit: paths.length,
        paths,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const { parsed, unrecognised } = parseRecords(rawFile, records, 'file_path', ctx);
      const wanted = new Set(paths);
      return {
        candidates: [
          ...unrecognised,
          ...parsed
            .filter((f) => f.exists && wanted.has(f.path))
            .map((f) => ({
              kind: 'candidate' as const,
              itemClass: 'file_path' as const,
              evidence: { kind: 'file_path' as const, path: f.path },
              observedAt: ctx.window.to,
              sourceLocator: f.locator,
            })),
        ],
        capped: false,
      };
    },
  };
}
