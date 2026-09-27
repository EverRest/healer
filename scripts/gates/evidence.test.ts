import { describe, expect, it } from 'vitest';
import { findConclusionTagsWithUnknownType } from './evidence.mjs';

const CONCLUSION_TYPE_ENUM = `
enum ConclusionType {
  classification
  diagnosis
  hypothesis
  impact
  verification
  support_answer
  remediation

  @@map("conclusion_type")
  @@schema("evidence")
}
`;

describe('gate-evidence (012 T031, 001 FR-009/T010, quickstart 9)', () => {
  it('fails when a @conclusion model is tagged with a type outside ConclusionType', () => {
    const schema = `${CONCLUSION_TYPE_ENUM}
      /// @conclusion made_up_type
      model Diagnosis {
        id String @id @db.Uuid
      }
    `;
    expect(findConclusionTagsWithUnknownType(schema)).toEqual([
      'Diagnosis: tagged @conclusion made_up_type, which is not a ConclusionType value ' +
        '(classification, diagnosis, hypothesis, impact, verification, support_answer, remediation)',
    ]);
  });

  it('fails when @conclusion is tagged with no type at all', () => {
    const schema = `${CONCLUSION_TYPE_ENUM}
      /// @conclusion
      model Diagnosis {
        id String @id @db.Uuid
      }
    `;
    expect(findConclusionTagsWithUnknownType(schema)).toEqual([
      'Diagnosis: tagged @conclusion with no type — must name a ConclusionType value',
    ]);
  });

  it('passes a @conclusion model tagged with a real ConclusionType value', () => {
    const schema = `${CONCLUSION_TYPE_ENUM}
      /// @conclusion diagnosis
      model Diagnosis {
        id String @id @db.Uuid
      }
    `;
    expect(findConclusionTagsWithUnknownType(schema)).toEqual([]);
  });

  it('ignores an untagged model entirely', () => {
    const schema = `${CONCLUSION_TYPE_ENUM}
      model NotAConclusion {
        id String @id @db.Uuid
      }
    `;
    expect(findConclusionTagsWithUnknownType(schema)).toEqual([]);
  });
});
