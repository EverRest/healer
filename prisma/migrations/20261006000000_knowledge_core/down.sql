-- Reverses 20261006000000_knowledge_core. CASCADE drops the composite FKs (including the circular
-- current_version_id pair) with their tables; nothing outside the `knowledge` schema references it.
DROP TABLE "knowledge"."knowledge_constraint" CASCADE;
DROP TABLE "knowledge"."anchor_grant" CASCADE;
DROP TABLE "knowledge"."adoption_record" CASCADE;
DROP TABLE "knowledge"."expected_behavior" CASCADE;
DROP TABLE "knowledge"."expected_behavior_version" CASCADE;
DROP TABLE "knowledge"."duplicate_group" CASCADE;
DROP TABLE "knowledge"."document_section" CASCADE;
DROP TABLE "knowledge"."document_version" CASCADE;
DROP TABLE "knowledge"."knowledge_document" CASCADE;
DROP TABLE "knowledge"."knowledge_source" CASCADE;

DROP TYPE "knowledge"."constraint_value_type";
DROP TYPE "knowledge"."constraint_scope_kind";
DROP TYPE "knowledge"."adoption_actor_type";
DROP TYPE "knowledge"."duplicate_method";
DROP TYPE "knowledge"."expected_behavior_state";
DROP TYPE "knowledge"."knowledge_availability";
DROP TYPE "knowledge"."expectation_provenance";
DROP TYPE "knowledge"."knowledge_provenance";
DROP TYPE "knowledge"."knowledge_document_class";
DROP TYPE "knowledge"."knowledge_sync_state";
DROP TYPE "knowledge"."knowledge_connection_state";
DROP TYPE "knowledge"."knowledge_source_kind";

DROP FUNCTION "knowledge"."section_search_vector"(text[], text);

DROP SCHEMA "knowledge";
