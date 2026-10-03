import { z } from 'zod';
import type { Collector, SourcePort } from './types.js';
import { isoTimestamp, parseRecords } from './helpers.js';

// `value` is `unknown` and is only ever measured (`typeof`, length) — it is never copied into a
// shape, an excerpt, a log line or an error message (FR-007, quickstart 4).
const rawConfigKey = z.object({
  keyPath: z.string().regex(/^[A-Za-z0-9_./:-]{1,200}$/),
  value: z.unknown().optional(),
  changedAt: isoTimestamp.optional(),
  locator: z.string(),
});

function valueType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function lengthClass(value: unknown): string {
  const length = typeof value === 'string' ? value.length : (JSON.stringify(value) ?? '').length;
  return length === 0 ? 'empty' : length <= 16 ? 'short' : length <= 128 ? 'medium' : 'long';
}

/**
 * `config_flags` (003 T023–T024, C-20): configuration and feature flags cross as `config_key_ref` —
 * key path, declaring component, environment, `present`/`absent`, value type and a length class.
 * Never the value, in any form, and never as `tool_output_summary`. The shape has no
 * change-indicator field (open cross-spec item, recorded in QUESTIONS.md), so none crosses.
 */
export function configFlagsCollector(source: SourcePort): Collector {
  return {
    key: 'config_flags',
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
      const { parsed, unrecognised } = parseRecords(rawConfigKey, records, 'config_key_ref', ctx);
      const capped = parsed.length > ctx.maxItems;
      return {
        candidates: [
          ...unrecognised,
          ...parsed.slice(0, ctx.maxItems).map((r) => ({
            kind: 'candidate' as const,
            itemClass: 'config_key_ref' as const,
            evidence: {
              kind: 'config_key_ref' as const,
              keyPath: r.keyPath,
              component,
              environment,
              presence: r.value === undefined ? ('absent' as const) : ('present' as const),
              type: valueType(r.value),
              lengthClass: lengthClass(r.value),
            },
            observedAt: new Date(r.changedAt ?? ctx.window.to),
            sourceLocator: r.locator,
          })),
        ],
        capped,
      };
    },
  };
}
