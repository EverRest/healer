DROP TRIGGER "anchor_grant_no_truncate" ON "knowledge"."anchor_grant";
DROP TRIGGER "anchor_grant_guard" ON "knowledge"."anchor_grant";
DROP FUNCTION "knowledge"."guard_anchor_grant"();

DROP TRIGGER "adoption_record_no_truncate" ON "knowledge"."adoption_record";
DROP TRIGGER "adoption_record_append_only" ON "knowledge"."adoption_record";
DROP TRIGGER "expected_behavior_version_no_truncate" ON "knowledge"."expected_behavior_version";
DROP TRIGGER "expected_behavior_version_append_only" ON "knowledge"."expected_behavior_version";
DROP TRIGGER "document_version_no_truncate" ON "knowledge"."document_version";
DROP TRIGGER "document_version_append_only" ON "knowledge"."document_version";
