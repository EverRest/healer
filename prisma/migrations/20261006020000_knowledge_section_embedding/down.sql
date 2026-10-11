-- Dropping the parent drops every tenant partition (and the HNSW index on each) with it. Embeddings
-- hold no source-of-truth data: they are rebuilt from document_section.
DROP FUNCTION "knowledge"."ensure_section_embedding_partition"(uuid);
DROP FUNCTION "knowledge"."section_embedding_partition_of"(uuid);
DROP TABLE "knowledge"."section_embedding" CASCADE;
