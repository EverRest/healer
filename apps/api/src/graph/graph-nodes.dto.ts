import { z } from 'zod';
import type { GraphNodeFilter } from '@healer/domain-architecture';

/** A query-string integer inside `[min, max]`: absent stays absent, anything else is rejected. */
const queryInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .transform(Number)
    .refine((n) => n >= min && n <= max, `must be from ${min} to ${max}`)
    .optional();

/** `smallint` strength column; `int` version columns with 2147483647 reserved for open rows. */
const strengthParam = queryInt(0, 32767);
const versionParam = queryInt(1, 2147483646);

/**
 * `GET /graph/nodes` query (contracts/openapi.yaml). `nodeKind`, `layer` and `state` are passed
 * through as strings: the closed sets live in the schema's enums and the repository refuses a
 * value outside them, so no second copy of those lists exists here. `minStrength` is an
 * explanation filter only (FR-016) — this is the only place it is accepted.
 */
export const graphNodeQuerySchema = z
  .object({
    nodeKind: z.string().min(1).optional(),
    layer: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    minStrength: strengthParam,
    graphVersion: versionParam,
  })
  .strict()
  .transform(({ nodeKind, layer, state, minStrength, graphVersion }): GraphNodeFilter => ({
    ...(nodeKind !== undefined ? { nodeKind } : {}),
    ...(layer !== undefined ? { layer } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(minStrength !== undefined ? { minStrength } : {}),
    ...(graphVersion !== undefined ? { graphVersion } : {}),
  }));

/** `GET /graph/nodes/{nodeId}` query: the pin and nothing else (an unknown parameter is a 400). */
export const graphNodeDetailQuerySchema = z.object({ graphVersion: versionParam }).strict();

/** First issue as `path: message`, so the caller learns which parameter was wrong. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'malformed';
  const where =
    issue.path.length > 0
      ? issue.path.join('.')
      : issue.code === 'unrecognized_keys'
        ? issue.keys.join(', ')
        : '';
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}
