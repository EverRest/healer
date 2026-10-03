-- Reverse of 20261004000000_context_core. The shared trigger functions belong to 001's migration
-- and are not dropped here; dropping the tables drops their triggers and constraints with them.
DROP TABLE "context"."context_item";
DROP TABLE "context"."source_outcome";
DROP TABLE "context"."collection_pass";
DROP TABLE "context"."context_snapshot";
DROP TABLE "context"."boundary_rejection";
DROP TABLE "context"."collector_registration";
DROP TABLE "context"."redaction_ruleset";
DROP TABLE "context"."ranking_ruleset";
DROP TABLE "context"."collection_ruleset";

DROP TYPE "context"."pass_outcome";
DROP TYPE "context"."inclusion_state";
DROP TYPE "context"."component_attribution";
DROP TYPE "context"."context_budget_state";
DROP TYPE "context"."follow_up_reason";
DROP TYPE "context"."gap_reason_code";
DROP TYPE "context"."source_status";
DROP TYPE "context"."item_class";
DROP TYPE "context"."collector_key";

DROP SCHEMA "context";
