import { skeletonContextSource } from '../context-source.js';

/** OpenTelemetry traces for `otel_traces` — beside, and separate from, 004's discovery adapter. Skeleton (003 T005). */
export const otelContextSource = skeletonContextSource('otel', ['otel_traces']);
