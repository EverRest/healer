import { describe, expect, it } from 'vitest';
import { modelTable } from './evidence-coverage.mjs';

const SCHEMA = `
/// @conclusion diagnosis
model Diagnosis {
  id       String @id @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid

  @@map("diagnosis")
  @@schema("evidence")
}

model NoMapping {
  id String @id @db.Uuid
}
`;

describe('modelTable (001 T033, SC-002)', () => {
  it('resolves a tagged model to its real schema-qualified table name', () => {
    expect(modelTable(SCHEMA, 'Diagnosis')).toEqual({ schema: 'evidence', table: 'diagnosis' });
  });

  it('returns null for a model with no @@map/@@schema', () => {
    expect(modelTable(SCHEMA, 'NoMapping')).toBeNull();
  });

  it('returns null for a model that does not exist at all', () => {
    expect(modelTable(SCHEMA, 'DoesNotExist')).toBeNull();
  });
});
