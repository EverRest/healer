import { z } from 'zod';
import type { ItemClass } from '@healer/boundary-contract';
import type { CollectContext, Unrecognised } from './types.js';

/**
 * Parses what a source port returned. The port returns `unknown` — a customer system's answer is
 * untrusted until a collector's own schema has read it — and a record that does not parse becomes
 * `Unrecognised`: withheld with its original kept locally, never dropped and never guessed at.
 */
export function parseRecords<S extends z.ZodTypeAny>(
  schema: S,
  records: readonly unknown[],
  itemClass: ItemClass,
  ctx: CollectContext,
): { parsed: z.infer<S>[]; unrecognised: Unrecognised[] } {
  const parsed: z.infer<S>[] = [];
  const unrecognised: Unrecognised[] = [];
  for (const record of records) {
    const result = schema.safeParse(record);
    if (result.success) {
      parsed.push(result.data);
      continue;
    }
    unrecognised.push({
      kind: 'unrecognised',
      itemClass,
      observedAt: ctx.window.to,
      sourceLocator: 'unparsed source record',
      original: JSON.stringify(record) ?? String(record),
    });
  }
  return { parsed, unrecognised };
}

// `datetime({offset:true})` accepts offsets `Date` cannot parse (`+24:00`); a timestamp that is not a
// real instant is an unrecognised record, not a crash two layers later.
export const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real instant');
