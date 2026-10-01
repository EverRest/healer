import { describe, expect, it } from 'vitest';
import type { GitlabProjectReader } from './gitlab/gitlab-adapter.js';
import type { KubernetesReader } from './kubernetes/kubernetes-adapter.js';
import type { TraceReader } from './otel/otel-adapter.js';

/**
 * Type-level proof that each discovery port is read-only by construction (FR-022): the interface
 * declares no write method, so `tsc --build` — not a runtime check — is what fails the build if
 * one is ever added under one of these names. Pattern: packages/domain/architecture/src/domain/
 * graph-node-repository.test.ts's `@ts-expect-error` proof against the real interface.
 *
 * `repo`-style stubs are real (never-invoked) values, not `declare const`s: `@ts-expect-error`
 * below references them as values, and vitest's esbuild transform strips types without erasing
 * that reference — an ambient declaration would throw `ReferenceError` the moment this runs.
 */
const gitlabReader: GitlabProjectReader = {
  project: () => Promise.reject(new Error('type-proof stub, never called')),
  listFiles: () => Promise.reject(new Error('type-proof stub, never called')),
  readFile: () => Promise.reject(new Error('type-proof stub, never called')),
};
const kubernetesReader: KubernetesReader = {
  listWorkloads: () => Promise.reject(new Error('type-proof stub, never called')),
};
const traceReader: TraceReader = {
  serviceEdges: () => Promise.reject(new Error('type-proof stub, never called')),
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error GitlabProjectReader has no write method
  gitlabReader.writeFile('path', 'content');
  // @ts-expect-error KubernetesReader has no write method
  kubernetesReader.applyWorkload({});
  // @ts-expect-error TraceReader has no write method
  traceReader.recordSpan({});
}
void typeProofNeverCalled;

describe('discovery ports are read-only by construction (A2, FR-022)', () => {
  it('compiles only because the stubs above satisfy the real read-only interfaces', () => {
    expect(gitlabReader).toBeDefined();
    expect(kubernetesReader).toBeDefined();
    expect(traceReader).toBeDefined();
  });
});
