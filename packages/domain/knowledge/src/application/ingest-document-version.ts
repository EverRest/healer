import { createHash } from 'node:crypto';
import type { TenantContext } from '@healer/shared';
import { parseFrontMatter, type ParsedConstraint } from '../domain/front-matter.js';
import { splitSections } from '../domain/markdown-sections.js';
import type {
  RepositoryFileCommit,
  RepositoryMarkdownSource,
} from '../domain/repository-markdown-source.js';
import { untrustedText, type UntrustedText } from '../domain/untrusted-text.js';

/**
 * `IngestDocumentVersion` (005 T017, C-06, R-08): repository markdown is the only text adapter in v1.
 *
 * Everything that can fail on the FILE (front matter, sections) fails here, before any write: the
 * store receives a complete, already-valid plan and writes it in one transaction, so a broken block
 * leaves the previous version standing and nothing partial behind (T018).
 *
 * Freshness and authorship are the commit's (`lastCommit`), copied through verbatim; no field of the
 * file can reach them (T020).
 */
export interface PlannedSection {
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  /** Untrusted until persisted: the store is the one reviewed place that unwraps it ('indexing'). */
  readonly content: UntrustedText;
  readonly charStart: number;
  readonly charEnd: number;
}

export interface PlannedExpectation {
  readonly stableKey: string;
  readonly description: string;
  readonly contentHash: string;
}

export interface IngestPlan {
  readonly sourceId: string;
  /** Repository-relative path = the document's `external_ref`. */
  readonly path: string;
  readonly title: string;
  readonly contentHash: string;
  readonly lastCommit: RepositoryFileCommit;
  /**
   * Named by the front matter, NOT resolved: the confirmed graph (004) lookup is a later task, so
   * `component_node_id` / `feature_node_id` stay null (see the 005 report, judgment calls).
   */
  readonly feature: string;
  readonly component: string;
  /** Deterministic stand-in for the feature node id until 004 resolves it (see `featureScopeRef`). */
  readonly featureScopeRef: string;
  readonly sections: readonly PlannedSection[];
  readonly expectations: readonly PlannedExpectation[];
  readonly constraints: readonly ParsedConstraint[];
}

export interface IngestOutcome {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly versionNo: number;
  /** False when the file's content hash equals the current version's: nothing was written. */
  readonly created: boolean;
}

/** The persistence port; one transaction per call, tenant from the context only. */
export interface KnowledgeIngestStore {
  ingest(tenant: TenantContext, plan: IngestPlan): Promise<IngestOutcome>;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Fixed derivation namespace: a ref hashed under it is a NAME-DERIVED PLACEHOLDER, not a graph node id. */
export const UNRESOLVED_FEATURE_SCOPE_NAMESPACE = 'healer:005:unresolved-feature-scope:v1';

/**
 * PLACEHOLDER — NOT A GRAPH NODE ID. `knowledge_constraint.scope_ref` is a NOT NULL uuid and the
 * feature node does not exist until 004's confirmed graph can resolve it, so until then constraints
 * are scoped by a name-derived uuid: sha256 over `UNRESOLVED_FEATURE_SCOPE_NAMESPACE`, the tenant
 * and the NORMALISED feature name (NFKC, trimmed, whitespace collapsed, lowercased), so `Checkout`
 * and ` checkout ` share a scope across documents and versions (two files naming one feature must
 * collide, so a conflict is representable — FR-015). A hash cannot be recognised afterwards, so
 * T079/T082 and Phase 3 MUST re-point these rows to the resolved feature node id (data-model.md).
 */
export function featureScopeRef(tenant: TenantContext, feature: string): string {
  const name = feature.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const h = sha256(`${UNRESOLVED_FEATURE_SCOPE_NAMESPACE}:${tenant.tenantId}:${name}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** First real heading (the section splitter ignores code fences and strips CR), else the file name. */
function titleOf(path: string, sections: readonly { headingPath: readonly string[] }[]): string {
  return (
    sections.find((s) => s.headingPath.length > 0)?.headingPath[0] ??
    path.slice(path.lastIndexOf('/') + 1)
  );
}

/**
 * Largest file the ingest will parse, in UTF-8 bytes (1 MiB). PAIRED with `MAX_MARKDOWN_BYTES` in
 * `packages/integrations/src/gitlab/gitlab-markdown-source.ts` (knowledge cannot import integrations):
 * the adapter enforces it at the edge, this is the ingest's own check — it does not trust the port.
 */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Most sections one document version may create: a bound on rows written in one transaction. */
export const MAX_SECTIONS_PER_VERSION = 5000;

export class DocumentTooLargeError extends Error {
  readonly code = 'DOCUMENT_TOO_LARGE';
  constructor(readonly limitBytes: number) {
    super(`DOCUMENT_TOO_LARGE: the file is larger than ${limitBytes} bytes`);
    this.name = 'DocumentTooLargeError';
  }
}

export class IngestDocumentVersion {
  constructor(
    private readonly source: RepositoryMarkdownSource,
    private readonly store: KnowledgeIngestStore,
  ) {}

  async execute(
    tenant: TenantContext,
    input: { readonly sourceId: string; readonly path: string },
    signal?: AbortSignal,
  ): Promise<IngestOutcome> {
    const file = await this.source.read(input.path, signal);
    if (Buffer.byteLength(file.text, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new DocumentTooLargeError(MAX_DOCUMENT_BYTES); // before any parsing
    }
    const { frontMatter, bodyStart } = parseFrontMatter(file.text);
    const raw = splitSections(file.text, bodyStart, MAX_SECTIONS_PER_VERSION);
    const plan: IngestPlan = {
      sourceId: input.sourceId,
      path: file.path,
      title: titleOf(file.path, raw),
      contentHash: sha256(file.text),
      lastCommit: file.lastCommit,
      feature: frontMatter.feature,
      component: frontMatter.component,
      featureScopeRef: featureScopeRef(tenant, frontMatter.feature),
      sections: raw.map((s) => ({
        ...s,
        content: untrustedText(s.content),
      })),
      expectations: frontMatter.expectedBehaviors.map((e) => ({
        stableKey: e.id,
        description: e.description,
        contentHash: sha256(e.description),
      })),
      constraints: frontMatter.constraints,
    };
    return this.store.ingest(tenant, plan);
  }
}
