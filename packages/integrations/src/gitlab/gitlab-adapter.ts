import type {
  ComponentCandidate,
  DependencyObservation,
  RepositoryRef,
} from '@healer/boundary-contract';
import type {
  CollectionGap,
  DiscoveryAdapter,
  DiscoveryFacts,
  DiscoveryScope,
} from '@healer/domain-architecture';

/**
 * Read-only seam a runner-side GitLab HTTP client plugs into later (012-runner; no credentials or
 * config exist yet in this batch — see QUESTIONS.md "004 Phase 3 — adapter collection (A2)"). Every
 * method is read-only by construction: there is no write method on this interface to call.
 */
export interface GitlabProjectReader {
  project(signal?: AbortSignal): Promise<{
    readonly projectRef: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly headCommitMessage: string;
  }>;
  /** Repository-relative paths only — never contents (FR-021, FR-026). */
  listFiles(signal?: AbortSignal): Promise<readonly string[]>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
}

const GITLAB_ADAPTER_ID = 'gitlab';
const GITLAB_ADAPTER_VERSION = '0.2.0';
const GITLAB_LAYER = 'code';
const GITLAB_PROVENANCE = 'derived_from_code';

const ROOT_MANIFEST = 'package.json';
const MANIFEST_SUFFIX = '/package.json';

interface ParsedManifest {
  readonly dir: string;
  readonly rawName: string;
  readonly naturalKey: string;
  readonly dependencyNames: readonly string[];
}

function packageDirectory(manifestPath: string): string {
  return manifestPath.slice(0, manifestPath.length - MANIFEST_SUFFIX.length);
}

function unscopedName(name: string): string {
  const slash = name.indexOf('/');
  return name.startsWith('@') && slash !== -1 ? name.slice(slash + 1) : name;
}

/** Adapter-local heuristic (FR-020 — architecture-specific logic exists only here). */
function inferComponentType(dir: string, rawName: string): string {
  const haystack = `${dir} ${rawName}`.toLowerCase();
  if (haystack.includes('worker')) return 'worker';
  if (haystack.includes('frontend') || haystack.includes('web')) return 'frontend';
  if (/^(packages|libs)\//.test(dir)) return 'library';
  return 'service';
}

function collectDependencyNames(raw: Record<string, unknown>): readonly string[] {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) {
    const bag = raw[key];
    if (bag && typeof bag === 'object') {
      for (const depName of Object.keys(bag)) names.add(depName);
    }
  }
  return [...names];
}

/** `null` = not a component manifest (no `name`); `'unparsable'` = T032's collection gap. */
function parseManifest(path: string, content: string): ParsedManifest | 'unparsable' | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return 'unparsable';
  }
  if (typeof raw !== 'object' || raw === null) return 'unparsable';
  const name = (raw as Record<string, unknown>).name;
  if (typeof name !== 'string') return null;
  const dir = packageDirectory(path);
  return {
    dir,
    rawName: name,
    naturalKey: unscopedName(name),
    dependencyNames: collectDependencyNames(raw as Record<string, unknown>),
  };
}

async function readManifests(
  reader: GitlabProjectReader,
  paths: readonly string[],
  scope: DiscoveryScope,
): Promise<{ manifests: ParsedManifest[]; gaps: CollectionGap[] }> {
  const manifests: ParsedManifest[] = [];
  const gaps: CollectionGap[] = [];
  for (const path of paths) {
    scope.signal?.throwIfAborted();
    const content = await reader.readFile(path, scope.signal);
    scope.signal?.throwIfAborted();
    const manifest = parseManifest(path, content);
    if (manifest === 'unparsable') {
      gaps.push({
        kind: 'collection_gap',
        what: path,
        why: 'unparsable manifest',
        withheldByRedaction: false,
      });
    } else if (manifest) {
      manifests.push(manifest);
    }
  }
  return { manifests, gaps };
}

function toComponentCandidate(manifest: ParsedManifest): ComponentCandidate {
  return {
    kind: 'component_candidate',
    naturalKey: manifest.naturalKey,
    name: manifest.naturalKey,
    componentType: inferComponentType(manifest.dir, manifest.rawName),
    characteristics: [],
    sourcePaths: [manifest.dir],
    adapterKey: GITLAB_ADAPTER_ID,
    adapterVersion: GITLAB_ADAPTER_VERSION,
  };
}

function buildDependencyObservations(
  manifests: readonly ParsedManifest[],
  observedAt: string,
): DependencyObservation[] {
  const byRawName = new Map(manifests.map((manifest) => [manifest.rawName, manifest] as const));
  const observations: DependencyObservation[] = [];
  for (const manifest of manifests) {
    for (const depName of manifest.dependencyNames) {
      const target = byRawName.get(depName);
      if (!target || target === manifest) continue;
      observations.push({
        kind: 'dependency_observation',
        fromNaturalKey: manifest.naturalKey,
        toNaturalKey: target.naturalKey,
        edgeType: 'depends_on',
        layer: GITLAB_LAYER,
        provenance: GITLAB_PROVENANCE,
        observationCount: 1,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        windowSeconds: 0,
      });
    }
  }
  return observations;
}

/**
 * Repository and code-layer discovery over a GitLab project (FR-020, contracts/graph-contract.md
 * §3). `provenance`/`layer` are fixed by `GITLAB_LAYER`/`GITLAB_PROVENANCE` above, reused for both
 * the frozen adapter fields and every emitted `dependency_observation` — one constant each, so the
 * two can't drift apart (AGENTS.md: prefer unrepresentable over checked).
 *
 * File contents and the commit message are read (`reader.project()`/`readFile()`) but never appear
 * in any emitted shape — only `projectRef`/`defaultBranch`/`headSha` and manifest-derived facts
 * cross (FR-021, FR-026).
 */
export function createGitlabAdapter(reader: GitlabProjectReader) {
  return Object.freeze({
    key: GITLAB_ADAPTER_ID,
    version: GITLAB_ADAPTER_VERSION,
    layer: GITLAB_LAYER,
    provenance: GITLAB_PROVENANCE,
    async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
      scope.signal?.throwIfAborted();
      const project = await reader.project(scope.signal);
      scope.signal?.throwIfAborted();
      const files = await reader.listFiles(scope.signal);
      scope.signal?.throwIfAborted();

      const manifestPaths = files.filter(
        (path) => path !== ROOT_MANIFEST && path.endsWith(MANIFEST_SUFFIX),
      );
      const { manifests, gaps } = await readManifests(reader, manifestPaths, scope);
      const observedAt = new Date().toISOString();

      const repositoryRef: RepositoryRef = {
        kind: 'repository_ref',
        projectRef: project.projectRef,
        defaultBranch: project.defaultBranch,
        headSha: project.headSha,
        componentNaturalKeys: manifests.map((manifest) => manifest.naturalKey),
      };

      return {
        componentCandidates: manifests.map(toComponentCandidate),
        deploymentUnitCandidates: [],
        dependencyObservations: buildDependencyObservations(manifests, observedAt),
        repositoryRefs: [repositoryRef],
        collectionGaps: gaps,
      };
    },
  } as const) satisfies DiscoveryAdapter;
}
