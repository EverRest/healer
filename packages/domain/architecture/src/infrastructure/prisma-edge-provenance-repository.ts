import { randomUUID } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import { type PrismaClient, withConcurrencyTranslation } from '@healer/prisma-client';
import {
  deriveEdgeConfidence,
  resolveConfidenceConfig,
  type ConfidenceConfig,
} from '../domain/edge-confidence.js';
import {
  assertValidObservation,
  InvalidEdgeObservationError,
  ObservationReplayMismatchError,
  type EdgeObservation,
  type EdgeProvenanceRepository,
  type MergedEdge,
} from '../domain/edge-observation.js';
import { GraphConcurrencyError } from '../domain/graph-concurrency-error.js';
import { provenanceStrength } from '../domain/provenance-strength.js';

// The open-row sentinel (R-04) is a literal in the SQL below, not a bind parameter: Postgres cannot
// infer a partial unique index from a parameterised predicate once it switches to a generic plan
// (after five executions), and `ON CONFLICT` then fails with 42P10.

interface LockedEdge {
  readonly id: string;
  readonly observation_count: bigint;
  readonly last_observed_at: Date | null;
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function loadConfig(tx: Tx, tenantId: string): Promise<ConfidenceConfig> {
  const row = await tx.confidenceConfig.findUnique({ where: { tenantId } });
  try {
    return resolveConfidenceConfig(row?.config);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid confidence configuration for tenant ${tenantId}: ${reason}`, {
      cause: error,
    });
  }
}

/**
 * A replay is identical. Anything else is a second fact under the same evidence id and must not
 * vanish into DO NOTHING. Confidence is derived, so it is not compared.
 */
async function assertReplayMatches(
  tx: Tx,
  o: TenantScoped<EdgeObservation>,
  edgeId: string,
): Promise<void> {
  const [existing] = await tx.$queryRaw<
    {
      provenance: string;
      adapter_key: string;
      adapter_version: string;
      discovery_run_id: string | null;
    }[]
  >`
    SELECT provenance::text AS provenance, adapter_key, adapter_version, discovery_run_id
    FROM "architecture"."edge_provenance"
    WHERE tenant_id = ${o.tenantId}::uuid AND edge_id = ${edgeId}::uuid
      AND observation_ref = ${o.observationRef}::uuid`;
  if (
    existing === undefined ||
    existing.provenance !== o.provenance ||
    existing.adapter_key !== o.adapterKey ||
    existing.adapter_version !== o.adapterVersion ||
    existing.discovery_run_id !== (o.discoveryRunId ?? null)
  ) {
    throw new ObservationReplayMismatchError(o.observationRef);
  }
}

export class PrismaEdgeProvenanceRepository implements EdgeProvenanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async mergeObservation(o: TenantScoped<EdgeObservation>): Promise<MergedEdge> {
    assertValidObservation(o);
    return withConcurrencyTranslation(
      () =>
        this.prisma.$transaction(async (tx) => {
          const config = await loadConfig(tx, o.tenantId);
          const strength = provenanceStrength(o.provenance);

          // The lock is the whole point. `edge_provenance_maintain_edge_max` recomputes the edge's
          // MAX() from a statement snapshot; two merges for one edge, unserialised, each compute it
          // without the other's uncommitted row and the later writer LOWERS the edge, silently.
          // Locking the edge row first makes the insert below run — and take its snapshot — only
          // after any earlier merge has committed (graph-edge-merge-race.e2e.test.ts holds a
          // writer open and proves it). The lock comes BEFORE any insert on purpose: an
          // `ON CONFLICT` founding insert would itself wait on a writer's row, hiding whether the
          // lock does anything.
          const lockEdge = async (): Promise<LockedEdge | undefined> =>
            (
              await tx.$queryRaw<LockedEdge[]>`
                SELECT id, observation_count, last_observed_at FROM "architecture"."graph_edge"
                WHERE tenant_id = ${o.tenantId}::uuid AND from_node_id = ${o.fromNodeId}::uuid
                  AND to_node_id = ${o.toNodeId}::uuid
                  AND edge_type = ${o.edgeType}::"architecture"."graph_edge_type"
                  AND layer = ${o.layer}::"architecture"."graph_layer"
                  AND valid_to_version = 2147483647
                FOR UPDATE`
            )[0];

          let edge = await lockEdge();
          let created = false;
          if (edge === undefined) {
            // The founding value is overwritten by the max trigger on the first provenance row;
            // it only has to be a valid, derived one.
            const founding = deriveEdgeConfidence(o, o.observedUntil, config);
            const inserted = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO "architecture"."graph_edge"
                (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
                 confidence, state, observation_count, valid_from_version)
              VALUES (${randomUUID()}::uuid, ${o.tenantId}::uuid, ${o.fromNodeId}::uuid,
                      ${o.toNodeId}::uuid, ${o.edgeType}::"architecture"."graph_edge_type",
                      ${o.layer}::"architecture"."graph_layer",
                      ${o.provenance}::"architecture"."provenance_class", ${strength},
                      ${founding}, 'proposed', 0, ${o.baseVersion})
              ON CONFLICT (tenant_id, from_node_id, to_node_id, edge_type, layer)
                WHERE valid_to_version = 2147483647 DO NOTHING
              RETURNING id`;
            // Only the writer whose insert landed created the edge; a loser of the race found it.
            created = inserted.length > 0;
            edge = await lockEdge();
          }
          if (edge === undefined) throw new GraphConcurrencyError('GraphEdge');

          // Confidence is a property of the EDGE's evidence after this observation lands, not of
          // this row's own count: fifty separate single observations are not fifty facts of one.
          const aggregateCount = Number(edge.observation_count) + o.observationCount;
          if (!Number.isSafeInteger(aggregateCount)) {
            throw new InvalidEdgeObservationError(
              'edge observation count overflows a safe integer',
            );
          }
          const aggregateLast =
            edge.last_observed_at !== null && edge.last_observed_at > o.lastObservedAt
              ? edge.last_observed_at
              : o.lastObservedAt;
          const confidence = deriveEdgeConfidence(
            {
              provenance: o.provenance,
              observationCount: aggregateCount,
              lastObservedAt: aggregateLast,
            },
            o.observedUntil,
            config,
          );

          const recorded = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "architecture"."edge_provenance"
              (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref,
               adapter_key, adapter_version, discovery_run_id, observation_count, last_observed_at)
            VALUES (${randomUUID()}::uuid, ${o.tenantId}::uuid, ${edge.id}::uuid,
                    ${o.provenance}::"architecture"."provenance_class", ${strength}, ${confidence},
                    ${o.observationRef}::uuid, ${o.adapterKey}, ${o.adapterVersion},
                    ${o.discoveryRunId ?? null}::uuid, ${o.observationCount},
                    ${o.lastObservedAt}::timestamptz)
            ON CONFLICT (tenant_id, edge_id, observation_ref) DO NOTHING
            RETURNING id`;

          if (recorded.length === 0) {
            await assertReplayMatches(tx, o, edge.id);
            return { edgeId: edge.id, created, recorded: false };
          }

          // strength/confidence are already the new MAX (trigger, same transaction); the rest of
          // the denormalised row follows from the rows now in edge_provenance.
          await tx.$executeRaw`
            UPDATE "architecture"."graph_edge"
            SET observation_count = observation_count + ${o.observationCount},
                last_observed_at = GREATEST(last_observed_at, ${o.lastObservedAt}::timestamptz),
                provenance = (
                  SELECT provenance FROM "architecture"."edge_provenance"
                  WHERE edge_id = ${edge.id}::uuid AND tenant_id = ${o.tenantId}::uuid
                  ORDER BY strength DESC, recorded_at ASC, id ASC LIMIT 1)
            WHERE id = ${edge.id}::uuid AND tenant_id = ${o.tenantId}::uuid`;
          return { edgeId: edge.id, created, recorded: true };
        }),
      () => new GraphConcurrencyError('GraphEdge'),
    );
  }
}
