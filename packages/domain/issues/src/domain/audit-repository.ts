import type { TenantScoped } from '@healer/shared';
import type { AgentRunFacts, AuditEntry, NewAuditEntry } from './audit.js';

/**
 * Write and read only (FR-012, R-03: `audit_entry` is append-only, same enforcement as
 * `evidence`/`issue_event`). `record` is meant to be called inside the *same* transaction as the
 * mutation it describes — the same pattern `IssueRepository.create`/`transition` already use for
 * `issue_event` + the outbox — not as a standalone follow-up call a crash between the two could
 * silently drop.
 *
 * No real caller wires this in yet: `action` must be a registered `policy_action.action_key`
 * (002), and 002 does not exist in this repo — inventing action-key values here would be guessing
 * at a closed list this feature does not own (flagged in QUESTIONS.md, not built ahead of 002).
 */
export interface AuditRepository {
  record(entry: TenantScoped<NewAuditEntry>): Promise<AuditEntry>;
  listByTarget(
    where: TenantScoped<{ readonly targetType: string; readonly targetId: string }>,
  ): Promise<readonly AuditEntry[]>;
  /**
   * SC-007: "every audit entry for an agent action resolves to a retrievable prompt version and
   * model identifier" — resolved through `agent_run`, the one place those facts are stored (C-13).
   * `null` when no `agent_run` row exists for this id under this tenant (a human/system/runner
   * actor's entry never has one to resolve, and an inconsistent reference is treated as
   * unresolvable, not fabricated).
   */
  resolveAgentRunFacts(
    where: TenantScoped<{ readonly agentRunId: string }>,
  ): Promise<AgentRunFacts | null>;
}
