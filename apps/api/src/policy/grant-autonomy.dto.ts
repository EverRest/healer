import { z } from 'zod';

/** `POST /autonomy/grants` body (T046, data-model.md `autonomy_grant`). `level` is validated to
 *  the schema's outer bound (0-5, data-model.md) here — the real, class-specific ceiling is
 *  `grantAutonomy`'s own check (`CeilingExceededError`, T034/T037), never duplicated as a second
 *  copy of the ceiling table at the HTTP edge. */
export const grantAutonomyRequestSchema = z
  .object({
    componentId: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    issueKind: z.string().min(1).optional(),
    actionKey: z.string().min(1),
    level: z.number().int().min(0).max(5),
  })
  .strict();
