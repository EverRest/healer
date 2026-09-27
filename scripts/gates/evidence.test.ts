import { describe, expect, it } from 'vitest';
import { findConclusionTypesWithNullableEvidence } from './evidence.mjs';

describe('gate-evidence (012 T031, 001 FR-009)', () => {
  it('fails when a @conclusion model has a nullable evidenceId', () => {
    const schema = `
      /// @conclusion
      model Diagnosis {
        id         String  @id @db.Uuid
        evidenceId String? @map("evidence_id") @db.Uuid
      }
    `;
    const issues = findConclusionTypesWithNullableEvidence(schema);
    expect(issues).toEqual(['Diagnosis: evidenceId is nullable (String?)']);
  });

  it('fails when a @conclusion model declares no evidenceId field at all', () => {
    const schema = `
      /// @conclusion
      model Diagnosis {
        id String @id @db.Uuid
      }
    `;
    expect(findConclusionTypesWithNullableEvidence(schema)).toEqual([
      'Diagnosis: tagged @conclusion but declares no evidenceId field',
    ]);
  });

  it('passes a @conclusion model with a non-nullable evidenceId', () => {
    const schema = `
      /// @conclusion
      model Diagnosis {
        id         String @id @db.Uuid
        evidenceId String @map("evidence_id") @db.Uuid
      }
    `;
    expect(findConclusionTypesWithNullableEvidence(schema)).toEqual([]);
  });

  it('ignores an untagged model with a nullable field of the same name', () => {
    const schema = `
      model NotAConclusion {
        id         String  @id @db.Uuid
        evidenceId String? @db.Uuid
      }
    `;
    expect(findConclusionTypesWithNullableEvidence(schema)).toEqual([]);
  });
});
