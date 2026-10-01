export { createGitlabAdapter } from './gitlab/gitlab-adapter.js';
export type { GitlabProjectReader } from './gitlab/gitlab-adapter.js';
export { createKubernetesAdapter } from './kubernetes/kubernetes-adapter.js';
export type { KubernetesReader, KubernetesWorkload } from './kubernetes/kubernetes-adapter.js';
export { createOtelAdapter } from './otel/otel-adapter.js';
export type { ServiceEdge, TraceReader } from './otel/otel-adapter.js';

// Test-support only (A2): an in-memory fixture for the three adapters above, not a production
// seam. Namespaced under a clearly test-support name so a later sub-batch's root e2e tests can
// import it without mistaking it for a real GitLab/Kubernetes/OTel client.
export * as testSupport from './test-support/design-partner.js';
