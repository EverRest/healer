// @healer/domain-knowledge — entry surface. Exports only what exists (012 FR-001).
export * from './domain/untrusted-text.js';
export * from './domain/capabilities.js';
export * from './domain/events.js';
export * from './domain/human-actor-ref.js';
export {
  EMBEDDING_DIMENSION,
  PrismaSectionEmbeddingRepository,
  type NearestSection,
} from './infrastructure/prisma-section-embedding-repository.js';
export * from './domain/repository-markdown-source.js';
export * from './application/document-excerpt-payload.js';
export * from './application/record-document-excerpt-evidence.js';
export * from './domain/front-matter.js';
export * from './domain/markdown-sections.js';
export * from './application/ingest-document-version.js';
export * from './infrastructure/prisma-knowledge-ingest-store.js';
export * from './infrastructure/prisma-knowledge-repositories.js';
