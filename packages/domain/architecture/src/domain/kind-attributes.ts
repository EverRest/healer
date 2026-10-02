import type { CharacteristicVocabulary } from './characteristics.js';
import {
  COMPONENT_TYPES,
  DEPLOYMENT_RUNTIME_KINDS,
  ENDPOINT_PROTOCOLS,
  REPOSITORY_VCS,
  type ComponentType,
  type DeploymentRuntimeKind,
  type EndpointProtocol,
  type RepositoryVcs,
} from './graph-vocabulary.js';

/**
 * Kind attributes (T044, T045, R-01): one row per node in a side table, never traversed. The value
 * types below have no field describing the architecture as a style (FR-001, D-09), and each
 * validator REFUSES an unknown key rather than ignoring it — so a style cannot be smuggled in
 * through a wider payload. A value only becomes persistable by passing a validator (`Validated`
 * is unforgeable outside this module), which is what `KindAttributeRepository`'s writes demand.
 */
declare const validatedBrand: unique symbol;
export type Validated<T> = T & { readonly [validatedBrand]: true };

export type AttrValidation<T> =
  | { readonly ok: true; readonly value: Validated<T> }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ComponentAttrValue {
  readonly componentType: ComponentType;
  readonly characteristics: readonly string[];
  readonly ownerRef: string | null;
}
export interface DeploymentUnitAttrValue {
  readonly environment: string;
  readonly runtimeKind: DeploymentRuntimeKind;
  readonly runtimeRef: string;
  readonly currentVersion: string | null;
}
export interface RepositoryAttrValue {
  readonly vcs: RepositoryVcs;
  readonly projectRef: string;
  readonly defaultBranch: string;
}
export interface EndpointAttrValue {
  readonly protocol: EndpointProtocol;
  readonly method: string | null;
  readonly pathTemplate: string | null;
  readonly contractRef: string | null;
}

type Raw = Readonly<Record<string, unknown>>;

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const optionalText = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

function finish<T>(errors: string[], value: T): AttrValidation<T> {
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as Validated<T> };
}

function unknownKeys(raw: Raw, allowed: readonly string[], errors: string[]): void {
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) errors.push(`unknown field ${key}`);
}

export function validateComponentAttr(
  raw: Raw,
  vocabulary: CharacteristicVocabulary,
): AttrValidation<ComponentAttrValue> {
  const errors: string[] = [];
  unknownKeys(raw, ['componentType', 'characteristics', 'ownerRef'], errors);
  if (!oneOf(COMPONENT_TYPES, raw.componentType))
    errors.push(`componentType must be one of ${COMPONENT_TYPES.join(', ')}`);
  const given = Array.isArray(raw.characteristics) ? (raw.characteristics as unknown[]) : null;
  if (given === null) errors.push('characteristics must be an array');
  for (const c of given ?? [])
    if (typeof c !== 'string' || !vocabulary.terms.has(c))
      errors.push(`unknown characteristic ${JSON.stringify(c)}`);
  return finish(errors, {
    componentType: raw.componentType as ComponentType,
    characteristics: [...new Set(given as string[])],
    ownerRef: optionalText(raw.ownerRef),
  });
}

export function validateDeploymentUnitAttr(raw: Raw): AttrValidation<DeploymentUnitAttrValue> {
  const errors: string[] = [];
  unknownKeys(raw, ['environment', 'runtimeKind', 'runtimeRef', 'currentVersion'], errors);
  if (!nonEmpty(raw.environment)) errors.push('environment is required');
  if (!oneOf(DEPLOYMENT_RUNTIME_KINDS, raw.runtimeKind))
    errors.push(`runtimeKind must be one of ${DEPLOYMENT_RUNTIME_KINDS.join(', ')}`);
  if (!nonEmpty(raw.runtimeRef)) errors.push('runtimeRef is required');
  return finish(errors, {
    environment: raw.environment as string,
    runtimeKind: raw.runtimeKind as DeploymentRuntimeKind,
    runtimeRef: raw.runtimeRef as string,
    currentVersion: optionalText(raw.currentVersion),
  });
}

export function validateRepositoryAttr(raw: Raw): AttrValidation<RepositoryAttrValue> {
  const errors: string[] = [];
  unknownKeys(raw, ['vcs', 'projectRef', 'defaultBranch'], errors);
  if (!oneOf(REPOSITORY_VCS, raw.vcs))
    errors.push(`vcs must be one of ${REPOSITORY_VCS.join(', ')}`);
  if (!nonEmpty(raw.projectRef)) errors.push('projectRef is required');
  if (!nonEmpty(raw.defaultBranch)) errors.push('defaultBranch is required');
  return finish(errors, {
    vcs: raw.vcs as RepositoryVcs,
    projectRef: raw.projectRef as string,
    defaultBranch: raw.defaultBranch as string,
  });
}

export function validateEndpointAttr(raw: Raw): AttrValidation<EndpointAttrValue> {
  const errors: string[] = [];
  unknownKeys(raw, ['protocol', 'method', 'pathTemplate', 'contractRef'], errors);
  if (!oneOf(ENDPOINT_PROTOCOLS, raw.protocol))
    errors.push(`protocol must be one of ${ENDPOINT_PROTOCOLS.join(', ')}`);
  return finish(errors, {
    protocol: raw.protocol as EndpointProtocol,
    method: optionalText(raw.method),
    pathTemplate: optionalText(raw.pathTemplate),
    contractRef: optionalText(raw.contractRef),
  });
}
