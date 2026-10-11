import { untrustedText, type UntrustedText } from '@healer/domain-knowledge';
import {
  byExternalRef,
  compareStrings,
  composeRef,
  sha256_12,
  type KnowledgeDocumentCandidate,
} from '../knowledge-candidate.js';

export interface TestName {
  readonly file: string;
  readonly name: string;
  /** Enclosing describe titles, outermost first. */
  readonly describePath?: readonly string[];
}

/** Read-only: test names only — no assertion bodies, no source. */
export interface TestNameReader {
  listTestNames(signal?: AbortSignal): Promise<readonly TestName[]>;
}

export interface ApiDescriptionCandidate extends KnowledgeDocumentCandidate {
  readonly method: string;
  /** The raw path is author text: carried untrusted; only a structural form reaches `externalRef`. */
  readonly path: UntrustedText;
  readonly responseCodes: readonly string[];
}

export class MalformedOpenApiError extends Error {
  constructor(what: string) {
    super(`malformed OpenAPI description: ${what}`);
    this.name = 'MalformedOpenApiError';
  }
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const STRUCTURAL_PATH = /^\/[A-Za-z0-9\-._~{}/]*$/;
const STRUCTURAL_FILE = /^[A-Za-z0-9\-._~/]+$/;
const RESPONSE_CODE = /^(?:[1-5](?:\d\d|XX)|default)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function responseCodes(method: string, responses: unknown): string[] {
  if (!isObj(responses)) throw new MalformedOpenApiError(`operation ${method} has no responses`);
  const codes = Object.keys(responses).filter((k) => !k.startsWith('x-'));
  if (codes.length === 0) throw new MalformedOpenApiError(`operation ${method} has no responses`);
  for (const code of codes) {
    if (!RESPONSE_CODE.test(code)) throw new MalformedOpenApiError('invalid response code');
  }
  return codes.sort(compareStrings);
}

function mapOperation(path: string, method: string, op: Obj): ApiDescriptionCandidate {
  const ref = STRUCTURAL_PATH.test(path) ? path : `#${sha256_12(path)}`;
  return {
    sourceKind: 'openapi',
    documentClass: 'api_description',
    externalRef: composeRef(`${method} ${ref}`),
    title: untrustedText(str(op['summary'])),
    body: untrustedText(str(op['description']) || str(op['summary'])),
    method,
    path: untrustedText(path),
    responseCodes: responseCodes(method, op['responses']),
  };
}

/**
 * One candidate per operation of an already-parsed, already-DEREFERENCED OpenAPI 3.x description
 * (parsing and `$ref` resolution are the caller's). Structural malformation throws
 * `MalformedOpenApiError` rather than yielding a silently empty list; `paths: {}` is valid.
 */
export function mapOpenApi(spec: unknown): ApiDescriptionCandidate[] {
  if (!isObj(spec) || !str(spec['openapi']).startsWith('3.')) {
    throw new MalformedOpenApiError('not an OpenAPI 3.x object');
  }
  const paths = spec['paths'];
  if (!isObj(paths)) throw new MalformedOpenApiError('`paths` missing or not an object');
  const out: ApiDescriptionCandidate[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) throw new MalformedOpenApiError('path does not start with /');
    if (!isObj(item)) throw new MalformedOpenApiError('path item is not an object');
    if ('$ref' in item) {
      throw new MalformedOpenApiError('path item is a $ref; the caller must dereference first');
    }
    for (const m of METHODS) {
      if (!(m in item)) continue;
      const op = item[m];
      if (!isObj(op)) throw new MalformedOpenApiError('operation is not an object');
      out.push(mapOperation(path, m.toUpperCase(), op));
    }
  }
  return out.sort(byExternalRef);
}

const join = (t: TestName): string => [...(t.describePath ?? []), t.name].join('\u0000');

/**
 * `externalRef` = `<file>#<sha12(describePath, name)>`, `.n` appended for the n-th (n>=2) identical
 * test in a file. Input order is irrelevant: sorted by (file, describePath+name) in code units.
 */
export function mapTestNames(tests: readonly TestName[]): KnowledgeDocumentCandidate[] {
  const sorted = [...tests].sort(
    (a, b) => compareStrings(a.file, b.file) || compareStrings(join(a), join(b)),
  );
  const seen = new Map<string, number>();
  return sorted.map((t) => {
    const file = STRUCTURAL_FILE.test(t.file) ? t.file : `#${sha256_12(t.file)}`;
    const base = `${file}#${sha256_12(join(t))}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      sourceKind: 'test_names' as const,
      documentClass: 'test_manifest' as const,
      externalRef: composeRef(n === 1 ? base : `${base}.${n}`),
      title: untrustedText(t.name),
      body: untrustedText(join(t).replaceAll('\u0000', ' > ')),
    };
  });
}
