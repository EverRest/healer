import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_TYPES,
  DEPLOYMENT_RUNTIME_KINDS,
  EDGE_TYPES,
  ENDPOINT_PROTOCOLS,
  NODE_KINDS,
  REPOSITORY_VCS,
} from './graph-vocabulary.js';

const schema = readFileSync(
  fileURLToPath(new URL('../../../../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

function enumMembers(name: string): string[] {
  const body = new RegExp(`^enum ${name} \\{([^}]*)\\}`, 'm').exec(schema)?.[1];
  if (body === undefined) throw new Error(`enum ${name} not found in schema.prisma`);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('@@') && !l.startsWith('//'));
}

function modelFields(name: string): string[] {
  const body = new RegExp(`^model ${name} \\{([^}]*)\\}`, 'm').exec(schema)?.[1];
  if (body === undefined) throw new Error(`model ${name} not found in schema.prisma`);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('@@') && !l.startsWith('//') && !l.startsWith('///'))
    .map((l) => l.split(/\s+/)[0] as string);
}

describe('graph-vocabulary.ts is the one authority; the database enums are pinned to it (T044-T046)', () => {
  it.each([
    ['GraphNodeKind', NODE_KINDS],
    ['GraphEdgeType', EDGE_TYPES],
    ['ComponentType', COMPONENT_TYPES],
    ['DeploymentRuntimeKind', DEPLOYMENT_RUNTIME_KINDS],
    ['RepositoryVcs', REPOSITORY_VCS],
    ['EndpointProtocol', ENDPOINT_PROTOCOLS],
  ] as const)('%s matches the schema enum exactly', (enumName, list) => {
    expect([...list].sort()).toEqual(enumMembers(enumName).sort());
  });
});

describe('component_attr cannot describe the architecture as a style (FR-001, D-09)', () => {
  it('its columns are exactly the attribute allow-list plus keys — nothing style-shaped', () => {
    const fields = modelFields('ComponentAttr').filter((f) => f !== 'node');
    expect(fields.sort()).toEqual(
      ['characteristics', 'componentType', 'nodeId', 'ownerRef', 'tenantId'].sort(),
    );
  });
});
