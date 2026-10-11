import { describe, expect, it } from 'vitest';
import type { GitlabProjectReader } from './gitlab/gitlab-adapter.js';
import type { KubernetesReader } from './kubernetes/kubernetes-adapter.js';
import type { TraceReader } from './otel/otel-adapter.js';
import type { GitlabMarkdownReader } from './gitlab/gitlab-markdown-source.js';
import type {
  GitHistoryReader,
  IssueReader,
  MergeRequestReader,
} from './gitlab/gitlab-knowledge-readers.js';
import type { TestNameReader } from './openapi/openapi-candidates.js';

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

/**
 * The three `@ts-expect-error` probes above only prove that *these particular* write-shaped names
 * aren't callable — a method named `deleteFile` would pass undetected (review finding). This is
 * the broader, name-agnostic proof: each port's key set is EXACTLY the given method names, not
 * merely "has at least these" (plain `extends` is satisfied by a wider type too, so it wouldn't
 * catch an addition). `Equals` is the standard distributive-conditional-on-a-bare-type-parameter
 * trick for true type equality in TypeScript.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type GitlabKeysExact = Equals<keyof GitlabProjectReader, 'project' | 'listFiles' | 'readFile'>;
type KubernetesKeysExact = Equals<keyof KubernetesReader, 'listWorkloads'>;
type TraceKeysExact = Equals<keyof TraceReader, 'serviceEdges'>;

// If a method (ANY method — `deleteFile`, `patchWorkload`, anything) were ever added to one of
// these interfaces, its `Equals<...>` above would evaluate to `false`, and assigning `true` to a
// `false`-typed binding below fails `tsc --build` — not a name-specific probe, a structural one.
const gitlabKeysExact: GitlabKeysExact = true;
const kubernetesKeysExact: KubernetesKeysExact = true;
const traceKeysExact: TraceKeysExact = true;

// 005 T003 knowledge ports: exact key sets, plus no key may contain a write/approval verb (R-02:
// Healer's credential holds no approval permission, so approving must be unrepresentable).
type WriteVerb =
  'approve' | 'merge' | 'comment' | 'write' | 'create' | 'update' | 'delete' | 'push' | 'post';
type NoWriteVerb<P> = [
  Extract<Lowercase<keyof P & string>, `${string}${WriteVerb}${string}`>,
] extends [never]
  ? true
  : false;
// `listMergeRequests` contains "merge" as a noun: the verb check applies to everything except it.
type NoWriteVerbExceptList<P> = NoWriteVerb<Omit<P, 'listMergeRequests'>>;

const markdownKeysExact: Equals<
  keyof GitlabMarkdownReader,
  'resolveRef' | 'entryKind' | 'listTree' | 'readFile' | 'lastCommitTouching'
> = true;
const historyKeysExact: Equals<keyof GitHistoryReader, 'listCommits'> = true;
const mrKeysExact: Equals<keyof MergeRequestReader, 'listMergeRequests'> = true;
const issueKeysExact: Equals<keyof IssueReader, 'listIssues'> = true;
const testNameKeysExact: Equals<keyof TestNameReader, 'listTestNames'> = true;
const noWriteVerbs: [
  NoWriteVerb<GitlabMarkdownReader>,
  NoWriteVerb<GitHistoryReader>,
  NoWriteVerbExceptList<MergeRequestReader>,
  NoWriteVerb<IssueReader>,
  NoWriteVerb<TestNameReader>,
] = [true, true, true, true, true];

describe('knowledge ports are read-only by construction (005 T003, R-02)', () => {
  it('compiles only because each port exposes exactly its read methods and no write verb', () => {
    expect([
      markdownKeysExact,
      historyKeysExact,
      mrKeysExact,
      issueKeysExact,
      testNameKeysExact,
    ]).toEqual([true, true, true, true, true]);
    expect(noWriteVerbs).toEqual([true, true, true, true, true]);
  });
});

describe('discovery ports are read-only by construction (A2, FR-022)', () => {
  it('compiles only because the stubs above satisfy the real read-only interfaces', () => {
    expect(gitlabReader).toBeDefined();
    expect(kubernetesReader).toBeDefined();
    expect(traceReader).toBeDefined();
  });

  it('compiles only because each port exposes exactly its read method(s), nothing more', () => {
    expect(gitlabKeysExact).toBe(true);
    expect(kubernetesKeysExact).toBe(true);
    expect(traceKeysExact).toBe(true);
  });
});
