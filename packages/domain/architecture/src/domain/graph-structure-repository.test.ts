import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { GraphStructureRepository } from './graph-structure-repository.js';
import type { ComponentAttrValue, Validated } from './kind-attributes.js';

/**
 * Tenant scoping and validated-only writes (004 T044-T046, FR-024) proven at the type level, same
 * technique as `graph-node-repository.test.ts`; the runtime isolation proof is
 * `graph-structure.e2e.test.ts`.
 */
const repo = {} as GraphStructureRepository;

/** Type-checked by `tsc --build`, never invoked. */
function typeProofNeverCalled(): void {
  // @ts-expect-error a plain { nodeId } is not TenantScoped
  void repo.getComponentAttr({ nodeId: 'n' });
  // @ts-expect-error listing violations also needs a proven tenant
  void repo.listEdgeEndpointViolations({});
  // @ts-expect-error an unvalidated attribute value cannot be saved
  void repo.saveComponentAttr({} as TenantScoped<{ nodeId: string }>, {
    componentType: 'service',
    characteristics: [],
    ownerRef: null,
  } satisfies ComponentAttrValue);
}
void typeProofNeverCalled;

describe('GraphStructureRepository (004 T044-T046)', () => {
  it('every read and write requires TenantScoped; writes require a Validated value', () => {
    expectTypeOf(repo.getComponentAttr)
      .parameter(0)
      .toEqualTypeOf<TenantScoped<{ readonly nodeId: string }>>();
    expectTypeOf(repo.saveComponentAttr)
      .parameter(1)
      .toEqualTypeOf<Validated<ComponentAttrValue>>();
  });

  it('a ComponentAttrValue has no architecture-style field (FR-001, D-09)', () => {
    expectTypeOf<keyof ComponentAttrValue>().toEqualTypeOf<
      'componentType' | 'characteristics' | 'ownerRef'
    >();
  });
});
