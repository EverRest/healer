// Mirrors 001's `audit_entry` shape as a plain local type — the same reason `@healer/domain-policy`
// mirrors it (a cross-domain-package import has no precedent and no ADR in this repository).
// A collection pass is written by the runner's batch, never by an agent, so `agentRunId` does not
// exist here.
export interface NewAuditEntry {
  readonly id: string;
  readonly actorType: 'runner' | 'system';
  readonly actorRef: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly outcome: string;
}
