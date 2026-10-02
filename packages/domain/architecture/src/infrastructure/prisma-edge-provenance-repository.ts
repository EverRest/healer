import { randomUUID } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import { type PrismaClient, withConcurrencyTranslation } from '@healer/prisma-client';
import { resolveConfidenceConfig, deriveEdgeConfidence } from '../domain/edge-confidence.js';
import type {
  EdgeObservation,
  EdgeProvenanceRepository,
  MergedEdge,
} from '../domain/edge-observation.js';
import { GraphConcurrencyError } from '../domain/graph-concurrency-error.js';
import { provenanceStrength } from '../domain/provenance-strength.js';

// The open-row sentinel (R-04) is a literal in the SQL below, not a bind parameter: Postgres cannot
// infer a partial unique index from a parameterised predicate once it switches to a generic plan
// (after five executions), and `ON CONFLICT` then fails with 42P10.

export class PrismaEdgeProvenanceRepository implements EdgeProvenanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async mergeObservation(
    o: TenantScoped<EdgeObservation>,
    now: Date = new Date(),
  ): Promise<MergedEdge> {
    return withConcurrencyTranslation(
      () =>
        this.prisma.$transaction(async (tx) => {
          const tenantRow = await tx.confidenceConfig.findUnique({
            where: { tenantId: o.tenantId },
          });
          const config = resolveConfidenceConfig(tenantRow?.config);
          // Both derived here, once, at write time — never from the observation's own claim.
          const strength = provenanceStrength(o.provenance);
          const confidence = deriveEdgeConfidence(o, now, config);

          // The lock is the whole point. `edge_provenance_maintain_edge_max` recomputes the edge's
          // MAX() from a statement snapshot; two merges for one edge, unserialised, each compute it
          // without the other's uncommitted row and the later writer LOWERS the edge, silently.
          // Locking the edge row first makes the insert below run — and take its snapshot — only
          // after any earlier merge has committed (graph-edge-merge-race.e2e.test.ts holds a
          // writer open and proves it). The lock comes BEFORE any insert on purpose: an
          // `ON CONFLICT` founding insert would itself wait on a writer's row, hiding whether the
          // lock does anything.
          const lockEdge = async () =>
            (
              await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM "architecture"."graph_edge"
                WHERE tenant_id = ${o.tenantId}::uuid AND from_node_id = ${o.fromNodeId}::uuid
                  AND to_node_id = ${o.toNodeId}::uuid
                  AND edge_type = ${o.edgeType}::"architecture"."graph_edge_type"
                  AND layer = ${o.layer}::"architecture"."graph_layer"
                  AND valid_to_version = 2147483647
                FOR UPDATE`
            )[0];

          let edge = await lockEdge();
          const created = edge === undefined;
          if (created) {
            await tx.$executeRaw`
              INSERT INTO "architecture"."graph_edge"
                (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
                 confidence, state, observation_count, valid_from_version)
              VALUES (${randomUUID()}::uuid, ${o.tenantId}::uuid, ${o.fromNodeId}::uuid,
                      ${o.toNodeId}::uuid, ${o.edgeType}::"architecture"."graph_edge_type",
                      ${o.layer}::"architecture"."graph_layer",
                      ${o.provenance}::"architecture"."provenance_class", ${strength},
                      ${confidence}, 'proposed', 0, ${o.baseVersion})
              ON CONFLICT (tenant_id, from_node_id, to_node_id, edge_type, layer)
                WHERE valid_to_version = 2147483647 DO NOTHING`;
            // A concurrent founder may have won the insert; either way the row is there to lock.
            edge = await lockEdge();
          }
          if (edge === undefined) throw new GraphConcurrencyError('GraphEdge');

          const recorded = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "architecture"."edge_provenance"
              (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref,
               adapter_key, adapter_version, discovery_run_id)
            VALUES (${randomUUID()}::uuid, ${o.tenantId}::uuid, ${edge.id}::uuid,
                    ${o.provenance}::"architecture"."provenance_class", ${strength}, ${confidence},
                    ${o.observationRef}::uuid, ${o.adapterKey}, ${o.adapterVersion},
                    ${o.discoveryRunId ?? null}::uuid)
            ON CONFLICT (tenant_id, edge_id, observation_ref) DO NOTHING
            RETURNING id`;

          if (recorded.length > 0) {
            // strength/confidence are already the new MAX (trigger, same transaction); the rest of
            // the denormalised row follows from the rows now in edge_provenance.
            await tx.$executeRaw`
              UPDATE "architecture"."graph_edge"
              SET observation_count = observation_count + ${o.observationCount},
                  last_observed_at = GREATEST(last_observed_at, ${o.lastObservedAt}::timestamptz),
                  provenance = (
                    SELECT provenance FROM "architecture"."edge_provenance"
                    WHERE edge_id = ${edge.id}::uuid AND tenant_id = ${o.tenantId}::uuid
                    ORDER BY strength DESC, recorded_at ASC LIMIT 1)
              WHERE id = ${edge.id}::uuid AND tenant_id = ${o.tenantId}::uuid`;
          }
          return { edgeId: edge.id, created, recorded: recorded.length > 0 };
        }),
      () => new GraphConcurrencyError('GraphEdge'),
    );
  }
}
