import { z } from 'zod';

/** `GET /boundary-rejections` query. The tenant is never a parameter — it is the authenticated one. */
export const boundaryRejectionsQuerySchema = z
  .object({
    runnerId: z.string().uuid().optional(),
    // `datetime({ offset: true })` also accepts offsets `Date` cannot parse (`+99:99`): refuse them here.
    since: z
      .string()
      .datetime({ offset: true })
      .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real instant')
      .optional(),
  })
  .strict();
