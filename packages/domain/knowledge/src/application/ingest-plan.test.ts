import { TenantContext } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import type { RepositoryMarkdownSource } from '../domain/repository-markdown-source.js';
import { TooManySectionsError } from '../domain/markdown-sections.js';
import {
  DocumentTooLargeError,
  MAX_DOCUMENT_BYTES,
  MAX_SECTIONS_PER_VERSION,
  featureScopeRef,
  IngestDocumentVersion,
  UNRESOLVED_FEATURE_SCOPE_NAMESPACE,
  type IngestPlan,
} from './ingest-document-version.js';

const A = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005a1');
const B = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005b2');

describe('featureScopeRef (placeholder until 004 resolves feature nodes)', () => {
  it('normalises the name: NFKC, trim, collapsed whitespace, lowercase', () => {
    const ref = featureScopeRef(A, 'checkout flow');
    for (const same of ['Checkout Flow', '  checkout   flow ', 'CHECKOUT\tFLOW', 'checkout flow']) {
      expect(featureScopeRef(A, same), same).toBe(ref);
    }
    expect(featureScopeRef(A, 'Ｃheckout flow')).toBe(ref); // fullwidth C, NFKC
    expect(featureScopeRef(A, 'checkout')).not.toBe(ref);
  });

  it('is per tenant, a well-formed v5-shaped uuid, and namespaced as unresolved', () => {
    expect(featureScopeRef(A, 'x')).not.toBe(featureScopeRef(B, 'x'));
    expect(featureScopeRef(A, 'x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(UNRESOLVED_FEATURE_SCOPE_NAMESPACE).toMatch(/unresolved/);
  });
});

describe('IngestDocumentVersion plan', () => {
  const plan = async (text: string): Promise<IngestPlan> => {
    let captured: IngestPlan | undefined;
    const source: RepositoryMarkdownSource = {
      listMarkdown: () => Promise.resolve([]),
      read: () =>
        Promise.resolve({
          path: 'docs/a.md',
          ref: 'r',
          text,
          lastCommit: { sha: 's', authorRef: 'a', committedAt: new Date(0) },
        }),
    };
    await new IngestDocumentVersion(source, {
      ingest: (_t, p) => {
        captured = p;
        return Promise.resolve({
          documentId: 'd',
          documentVersionId: 'v',
          versionNo: 1,
          created: true,
        });
      },
    }).execute(A, { sourceId: 's', path: 'docs/a.md' });
    return captured!;
  };
  const fm = '---\nfeature: f\ncomponent: c\n---\n';

  it('takes the title from the first real heading: not from a fence, CR stripped', async () => {
    expect((await plan(`${fm}\`\`\`\n# in a fence\n\`\`\`\n# Real Title\r\n`)).title).toBe(
      'Real Title',
    );
    expect((await plan(`${fm.replaceAll('\n', '\r\n')}# CRLF Title\r\nbody\r\n`)).title).toBe(
      'CRLF Title',
    );
    expect((await plan(`${fm}no headings here\n`)).title).toBe('a.md');
  });

  it('refuses a file over the byte cap BEFORE parsing it (the adapter cap is not trusted)', async () => {
    // Broken front matter: only a cap checked first yields DocumentTooLargeError.
    const big = `---\nnot: [valid\n---\n${'x'.repeat(MAX_DOCUMENT_BYTES)}`;
    await expect(plan(big)).rejects.toBeInstanceOf(DocumentTooLargeError);
    // At the cap exactly it proceeds to parsing (and fails there for its own reason).
    const edge = `---\nnot: [valid\n---\n`;
    await expect(plan(edge + 'x'.repeat(MAX_DOCUMENT_BYTES - edge.length))).rejects.toMatchObject({
      code: 'FRONT_MATTER_INVALID',
    });
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const chars = Math.floor(MAX_DOCUMENT_BYTES / 3) + 1; // < cap in characters, > cap in bytes
    const text = `${fm}${'€'.repeat(chars)}`;
    expect(text.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    await expect(plan(text)).rejects.toBeInstanceOf(DocumentTooLargeError);
  });

  it('refuses a version with more sections than the cap, quickly', async () => {
    const t = performance.now();
    await expect(
      plan(`${fm}${'# a\n'.repeat(MAX_SECTIONS_PER_VERSION + 1)}`),
    ).rejects.toBeInstanceOf(TooManySectionsError);
    expect(performance.now() - t).toBeLessThan(1000);
    expect((await plan(`${fm}${'# a\n'.repeat(MAX_SECTIONS_PER_VERSION)}`)).sections).toHaveLength(
      MAX_SECTIONS_PER_VERSION,
    );
  });

  it('hashes the original file text (BOM and CRLF included)', async () => {
    const lf = await plan(`${fm}# T\n`);
    const crlf = await plan(`${fm}# T\n`.replaceAll('\n', '\r\n'));
    expect(lf.contentHash).not.toBe(crlf.contentHash);
  });
});
