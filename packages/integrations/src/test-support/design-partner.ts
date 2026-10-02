import type { GitlabProjectReader } from '../gitlab/gitlab-adapter.js';
import type { KubernetesReader, KubernetesWorkload } from '../kubernetes/kubernetes-adapter.js';
import type { ServiceEdge, TraceReader } from '../otel/otel-adapter.js';

/**
 * In-memory fixture for a fictitious design-partner customer, used by this package's own adapter
 * tests (T030–T032) and re-exported (see `src/index.ts`, `testSupport`) so a later sub-batch's
 * root e2e tests can exercise the full pipeline without a real GitLab/Kubernetes/OTel backend.
 *
 * Every reader is read-only by construction (there is no write method on any of the three port
 * interfaces — see `ports-read-only.test.ts`) and records every call it receives (method + args)
 * so a test can assert the exact same sources were inspected across two runs (T031).
 */

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function recordCall(calls: RecordedCall[], method: string, args: readonly unknown[] = []): void {
  calls.push({ method, args });
}

/**
 * Resolves `value` one microtask later — standing in for the real I/O a runner-side HTTP client
 * will eventually do — while actually honouring `signal`: an abort fired after this is called but
 * before that microtask runs rejects the pending promise instead of resolving it, exactly as a real
 * `fetch(url, { signal })` would be cancelled mid-flight. Not just a pre-call `aborted` check (that
 * part is `scope.signal?.throwIfAborted()` in the adapters) — this is what proves a reader call that
 * is actually in flight can be interrupted, the gap the coordinator's review flagged.
 */
function abortable<T>(value: T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  if (!signal) return Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    queueMicrotask(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/** Appears verbatim in the fixture's README and one source file — T030 asserts it never appears
 *  in anything the three adapters emit; never treat it as anything but an inert test string. */
export const DESIGN_PARTNER_FILE_MARKER = 'DESIGN_PARTNER_FILE_MARKER_9f2c81';

/** Default head commit message — T030 asserts it never appears in anything emitted. */
export const DESIGN_PARTNER_COMMIT_MESSAGE = 'Add worker service package';

/** Default annotation values, one per workload — T030 asserts none ever appear in anything
 *  emitted; the backend one is also the default `annotationValue` override target for T031. */
export const DESIGN_PARTNER_ANNOTATION_VALUES = Object.freeze({
  backend: 'DESIGN_PARTNER_ANNOTATION_BACKEND_MARKER',
  frontend: 'DESIGN_PARTNER_ANNOTATION_FRONTEND_MARKER',
  worker: 'DESIGN_PARTNER_ANNOTATION_WORKER_MARKER',
});

function designPartnerFiles(
  fileOverrides: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: 'design-partner-monorepo',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
    }),
    'README.md': `# Design partner monorepo\n\n${DESIGN_PARTNER_FILE_MARKER}\n`,
    'apps/backend/package.json': JSON.stringify({
      name: '@acme/backend',
      version: '1.0.0',
      dependencies: {},
    }),
    'apps/backend/src/index.ts': `// ${DESIGN_PARTNER_FILE_MARKER}\nexport const start = (): void => undefined;\n`,
    'apps/frontend/package.json': JSON.stringify({
      name: '@acme/frontend',
      version: '1.0.0',
      dependencies: { '@acme/shared': 'workspace:*' },
    }),
    'apps/worker/package.json': JSON.stringify({
      name: '@acme/worker',
      version: '1.0.0',
      dependencies: { '@acme/backend': 'workspace:*', '@acme/shared': 'workspace:*' },
    }),
    'packages/shared/package.json': JSON.stringify({
      name: '@acme/shared',
      version: '1.0.0',
      dependencies: {},
    }),
    ...fileOverrides,
  };
}

export interface DesignPartnerGitlabOverrides {
  /** T031: prompt-injection content in the head commit message must not change what is emitted. */
  readonly headCommitMessage?: string;
  /** T032: replace or corrupt one file's content (e.g. an unparsable manifest) without touching
   *  the rest of the tree. */
  readonly fileOverrides?: Readonly<Record<string, string>>;
}

export interface DesignPartnerGitlabFixture {
  readonly reader: GitlabProjectReader;
  readonly calls: RecordedCall[];
}

export function createDesignPartnerGitlabReader(
  overrides: DesignPartnerGitlabOverrides = {},
): DesignPartnerGitlabFixture {
  const calls: RecordedCall[] = [];
  const files = designPartnerFiles(overrides.fileOverrides ?? {});
  const reader: GitlabProjectReader = {
    project(signal?: AbortSignal) {
      recordCall(calls, 'project');
      return abortable(
        {
          projectRef: 'design-partner/monorepo',
          defaultBranch: 'main',
          headSha: 'a1b2c3d4e5f6headsha',
          headCommitMessage: overrides.headCommitMessage ?? DESIGN_PARTNER_COMMIT_MESSAGE,
        },
        signal,
      );
    },
    listFiles(signal?: AbortSignal) {
      recordCall(calls, 'listFiles');
      return abortable(Object.keys(files), signal);
    },
    readFile(path: string, signal?: AbortSignal) {
      recordCall(calls, 'readFile', [path]);
      const content = files[path];
      if (content === undefined) {
        return Promise.reject(new Error(`design-partner fixture has no file at ${path}`));
      }
      return abortable(content, signal);
    },
  };
  return { reader, calls };
}

const KUBERNETES_NAMESPACE = 'production';

export interface DesignPartnerKubernetesOverrides {
  /** T031: prompt-injection content in an annotation value must not change what is emitted. */
  readonly annotationValue?: string;
}

function designPartnerWorkloads(backendAnnotationValue: string): readonly KubernetesWorkload[] {
  return [
    {
      namespace: KUBERNETES_NAMESPACE,
      kind: 'Deployment',
      name: 'backend',
      labels: { 'app.kubernetes.io/name': 'backend' },
      annotations: { 'design-partner.example.com/note': backendAnnotationValue },
      image: 'registry.example.com/design-partner/backend:1.4.2',
      lastDeployedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      namespace: KUBERNETES_NAMESPACE,
      kind: 'Deployment',
      name: 'frontend',
      labels: { 'app.kubernetes.io/name': 'frontend' },
      annotations: { 'design-partner.example.com/note': DESIGN_PARTNER_ANNOTATION_VALUES.frontend },
      image: 'registry.example.com/design-partner/frontend:2.0.0',
      lastDeployedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      namespace: KUBERNETES_NAMESPACE,
      kind: 'Deployment',
      name: 'worker',
      labels: { 'app.kubernetes.io/name': 'worker' },
      annotations: { 'design-partner.example.com/note': DESIGN_PARTNER_ANNOTATION_VALUES.worker },
      image: 'registry.example.com/design-partner/worker:0.9.1',
    },
  ];
}

export interface DesignPartnerKubernetesFixture {
  readonly reader: KubernetesReader;
  readonly calls: RecordedCall[];
}

export function createDesignPartnerKubernetesReader(
  overrides: DesignPartnerKubernetesOverrides = {},
): DesignPartnerKubernetesFixture {
  const calls: RecordedCall[] = [];
  const workloads = designPartnerWorkloads(
    overrides.annotationValue ?? DESIGN_PARTNER_ANNOTATION_VALUES.backend,
  );
  const reader: KubernetesReader = {
    listWorkloads(signal?: AbortSignal) {
      recordCall(calls, 'listWorkloads');
      return abortable(workloads, signal);
    },
  };
  return { reader, calls };
}

function designPartnerServiceEdges(): readonly ServiceEdge[] {
  return [
    {
      fromService: 'frontend',
      toService: 'backend',
      spanCount: 420,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-30T00:00:00.000Z',
    },
    {
      fromService: 'worker',
      toService: 'backend',
      spanCount: 133,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-30T00:00:00.000Z',
    },
  ];
}

export interface DesignPartnerOtelFixture {
  readonly reader: TraceReader;
  readonly calls: RecordedCall[];
}

export function createDesignPartnerOtelReader(): DesignPartnerOtelFixture {
  const calls: RecordedCall[] = [];
  const edges = designPartnerServiceEdges();
  const reader: TraceReader = {
    serviceEdges(windowSeconds: number, signal?: AbortSignal) {
      recordCall(calls, 'serviceEdges', [windowSeconds]);
      return abortable(edges, signal);
    },
  };
  return { reader, calls };
}
