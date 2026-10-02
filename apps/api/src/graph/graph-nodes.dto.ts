import { z } from 'zod';
import type { GraphNodeFilter } from '@healer/domain-architecture';

/** A query-string integer: absent stays absent, anything that is not a whole number is rejected. */
const queryInt = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number)
  .optional();

export const graphVersionSchema = queryInt;

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
    minStrength: queryInt,
    graphVersion: queryInt,
  })
  .strict()
  .transform(({ nodeKind, layer, state, minStrength, graphVersion }): GraphNodeFilter => ({
    ...(nodeKind !== undefined ? { nodeKind } : {}),
    ...(layer !== undefined ? { layer } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(minStrength !== undefined ? { minStrength } : {}),
    ...(graphVersion !== undefined ? { graphVersion } : {}),
  }));
