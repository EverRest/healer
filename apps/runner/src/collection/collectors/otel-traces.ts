import { z } from 'zod';
import type { Collector, SourcePort } from './types.js';
import { isStructuralName } from '../redaction/detectors.js';
import { isoTimestamp, parseRecords } from './helpers.js';

// Span `attributes` are where a payload hides; this schema does not name them, so they are never
// read. A name or edge is route-template-shaped (default-deny against the template vocabulary, with
// numeric ids, uuids and ips replaced first) or the record is unrecognised and withheld.
const SPAN_NAME = /^[A-Za-z0-9_.:/{}$@ -]{1,120}$/;
const rawTrace = z.object({
  spans: z
    .array(
      z.object({
        name: z.string().regex(SPAN_NAME).refine(isStructuralName, 'not a route template'),
        durationMs: z.number().nonnegative(),
        serviceEdge: z
          .string()
          .regex(/^[\w.:/>-]{1,120}$/)
          .refine(isStructuralName, 'not a service edge'),
        statusCode: z.string().regex(/^[\w.-]{1,20}$/),
      }),
    )
    .max(200),
  observedAt: isoTimestamp,
  locator: z.string(),
});

/** `otel_traces` (003 T016): span names, durations, service edges, status codes — no attributes. */
export function otelTracesCollector(source: SourcePort): Collector {
  return {
    key: 'otel_traces',
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
      const { parsed, unrecognised } = parseRecords(rawTrace, records, 'trace_shape', ctx);
      return {
        candidates: [
          ...unrecognised,
          ...parsed.slice(0, ctx.maxItems).map((t) => ({
            kind: 'candidate' as const,
            itemClass: 'trace_shape' as const,
            evidence: {
              kind: 'trace_shape' as const,
              spans: t.spans.map((s) => ({
                name: s.name,
                durationMs: s.durationMs,
                serviceEdge: s.serviceEdge,
                statusCode: s.statusCode,
              })),
            },
            observedAt: new Date(t.observedAt),
            sourceLocator: t.locator,
          })),
        ],
        capped: parsed.length > ctx.maxItems,
      };
    },
  };
}
