import { skeletonContextSource } from '../context-source.js';

/** Grafana Loki — log records for `loki_logs`. Skeleton (003 T005). */
export const lokiContextSource = skeletonContextSource('loki', ['loki_logs']);
