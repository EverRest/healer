import { describe, expect, it } from 'vitest';
import { findMissingDataModelUpdate } from './data-model.mjs';

describe('gate-data-model (012 T076, FR-015, quickstart 29)', () => {
  it('fails when schema.prisma changed with no data-model.md update anywhere', () => {
    const issue = findMissingDataModelUpdate(['prisma/schema.prisma', 'src/x.ts']);
    expect(issue).toMatch(/data-model\.md/);
  });

  it('passes when schema.prisma changed alongside a data-model.md', () => {
    expect(
      findMissingDataModelUpdate([
        'prisma/schema.prisma',
        'specs/012-engineering-foundation/data-model.md',
      ]),
    ).toBeNull();
  });

  it('is silent when the schema did not change at all', () => {
    expect(findMissingDataModelUpdate(['README.md', 'src/x.ts'])).toBeNull();
  });
});
