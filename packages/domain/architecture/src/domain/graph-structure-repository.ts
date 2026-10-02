import type { TenantScoped } from '@healer/shared';
import type {
  ComponentAttrValue,
  DeploymentUnitAttrValue,
  EndpointAttrValue,
  RepositoryAttrValue,
  Validated,
} from './kind-attributes.js';
import type { NaturalKeyCollision } from './natural-key-collisions.js';
import type { EdgeViolation } from './structural-edges.js';

type ByNode = TenantScoped<{ readonly nodeId: string }>;

/**
 * Kind attributes (T044, T045) and the structural-edge reader (T046). Every method takes a
 * `TenantScoped` filter, so a call without a proven tenant is a type error (FR-024); a node id from
 * another tenant, or of the wrong kind, is `NotFoundError` — never a leak. Writes accept only
 * `Validated` values, which only the validators in `kind-attributes.ts` can produce.
 */
export interface GraphStructureRepository {
  getComponentAttr(where: ByNode): Promise<ComponentAttrValue>;
  getDeploymentUnitAttr(where: ByNode): Promise<DeploymentUnitAttrValue>;
  getRepositoryAttr(where: ByNode): Promise<RepositoryAttrValue>;
  getEndpointAttr(where: ByNode): Promise<EndpointAttrValue>;
  saveComponentAttr(where: ByNode, attr: Validated<ComponentAttrValue>): Promise<void>;
  saveDeploymentUnitAttr(where: ByNode, attr: Validated<DeploymentUnitAttrValue>): Promise<void>;
  saveRepositoryAttr(where: ByNode, attr: Validated<RepositoryAttrValue>): Promise<void>;
  saveEndpointAttr(where: ByNode, attr: Validated<EndpointAttrValue>): Promise<void>;
  /** Open edges whose endpoint kinds break `validateEdge` — what a continuous check consumes. */
  listEdgeEndpointViolations(where: TenantScoped<object>): Promise<EdgeViolation[]>;
  /** Open, non-rejected components sharing a natural key — what a continuous check consumes (R-12). */
  listNaturalKeyCollisions(where: TenantScoped<object>): Promise<NaturalKeyCollision[]>;
}
