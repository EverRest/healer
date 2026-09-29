/*
  Warnings:

  - Added the required column `valid_from_version` to the `graph_edge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `valid_from_version` to the `graph_node` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "architecture"."graph_version_minted_by" AS ENUM ('confirmation', 'manual_edit', 'drift_resolution', 'rename');

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_from_node_id_idx";

-- DropIndex
DROP INDEX "architecture"."graph_edge_tenant_id_to_node_id_idx";

-- AlterTable
ALTER TABLE "architecture"."graph_edge" ADD COLUMN     "valid_from_version" INTEGER NOT NULL,
ADD COLUMN     "valid_to_version" INTEGER NOT NULL DEFAULT 2147483647;

-- AlterTable
ALTER TABLE "architecture"."graph_node" ADD COLUMN     "valid_from_version" INTEGER NOT NULL,
ADD COLUMN     "valid_to_version" INTEGER NOT NULL DEFAULT 2147483647;

-- CreateTable
CREATE TABLE "architecture"."graph_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "minted_by" "architecture"."graph_version_minted_by" NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "draft_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "graph_version_tenant_id_version_key" ON "architecture"."graph_version"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "graph_edge_tenant_id_from_node_id_valid_from_version_valid__idx" ON "architecture"."graph_edge"("tenant_id", "from_node_id", "valid_from_version", "valid_to_version");

-- CreateIndex
CREATE INDEX "graph_edge_tenant_id_to_node_id_valid_from_version_valid_to_idx" ON "architecture"."graph_edge"("tenant_id", "to_node_id", "valid_from_version", "valid_to_version");

-- CreateIndex
CREATE INDEX "graph_node_tenant_id_node_kind_valid_from_version_valid_to__idx" ON "architecture"."graph_node"("tenant_id", "node_kind", "valid_from_version", "valid_to_version");
