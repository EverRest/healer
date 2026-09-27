import { describe, expect, it } from 'vitest';
import { declaredAppendOnlyTriggers, findMissingOrDisabledTriggers } from './append-only.mjs';

const MIGRATION_SQL = `
CREATE OR REPLACE FUNCTION reject_mutation_unless_privileged() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_link_append_only
  BEFORE UPDATE OR DELETE ON "evidence"."evidence_link"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_unless_privileged();

CREATE TRIGGER evidence_link_no_truncate
  BEFORE TRUNCATE ON "evidence"."evidence_link"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_unless_privileged();

CREATE TRIGGER evidence_link_step_attribution
  BEFORE INSERT ON "evidence"."evidence_link"
  FOR EACH ROW EXECUTE FUNCTION reject_step_attribution_mismatch();
`;

describe('declaredAppendOnlyTriggers (001 T034, SC-003)', () => {
  it('finds both the UPDATE/DELETE and TRUNCATE triggers for a table', () => {
    expect(declaredAppendOnlyTriggers(MIGRATION_SQL)).toEqual([
      { name: 'evidence_link_append_only', schema: 'evidence', table: 'evidence_link' },
      { name: 'evidence_link_no_truncate', schema: 'evidence', table: 'evidence_link' },
    ]);
  });

  it('ignores a trigger enforcing a different rule (step attribution, not append-only)', () => {
    const names = declaredAppendOnlyTriggers(MIGRATION_SQL).map((t) => t.name);
    expect(names).not.toContain('evidence_link_step_attribution');
  });
});

describe('findMissingOrDisabledTriggers', () => {
  const declared = [{ name: 'evidence_append_only', schema: 'evidence', table: 'evidence' }];

  it('reports nothing when the live trigger exists and is enabled', () => {
    expect(
      findMissingOrDisabledTriggers(declared, [{ name: 'evidence_append_only', tgenabled: 'O' }]),
    ).toEqual([]);
  });

  it('reports a trigger that is present but disabled', () => {
    expect(
      findMissingOrDisabledTriggers(declared, [{ name: 'evidence_append_only', tgenabled: 'D' }]),
    ).toEqual(['evidence.evidence: trigger evidence_append_only is missing or disabled']);
  });

  it('reports a trigger that is entirely absent — the real bug this check exists to catch', () => {
    expect(findMissingOrDisabledTriggers(declared, [])).toEqual([
      'evidence.evidence: trigger evidence_append_only is missing or disabled',
    ]);
  });
});
