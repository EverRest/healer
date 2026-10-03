export { createGitlabAdapter } from './gitlab/gitlab-adapter.js';
export type { GitlabProjectReader } from './gitlab/gitlab-adapter.js';
export { createKubernetesAdapter } from './kubernetes/kubernetes-adapter.js';
export type { KubernetesReader, KubernetesWorkload } from './kubernetes/kubernetes-adapter.js';
export { createOtelAdapter } from './otel/otel-adapter.js';
export type { ServiceEdge, TraceReader } from './otel/otel-adapter.js';
export {
  skeletonContextSource,
  type ContextSourceAdapter,
  type ContextSourceRequest,
} from './context-source.js';
export { configFlagsContextSource } from './config-flags/config-flags-context-source.js';
export { gitlabContextSource } from './gitlab/gitlab-context-source.js';
export { grafanaContextSource } from './grafana/grafana-context-source.js';
export { lokiContextSource } from './loki/loki-context-source.js';
export { otelContextSource } from './otel/otel-context-source.js';
export { prometheusContextSource } from './prometheus/prometheus-context-source.js';

// Test-support only (A2): an in-memory fixture for the three adapters above, not a production
// seam. Namespaced under a clearly test-support name so a later sub-batch's root e2e tests can
// import it without mistaking it for a real GitLab/Kubernetes/OTel client.
export * as testSupport from './test-support/design-partner.js';
