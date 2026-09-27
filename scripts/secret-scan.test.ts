import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSecretIssues } from './secret-scan.mjs';

// Built from parts, not a literal header: this file is itself scanned by `secret-scan` once
// committed, and a literal `-----BEGIN...PRIVATE KEY-----` here would fail every `make ci`.
const PEM_HEADER = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PEM_FOOTER = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
const PGP_HEADER = ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' ');

describe('secret-scan (012 T074, quickstart 27)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a planted PEM private key', () => {
    dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    const path = join(dir, 'id_rsa');
    writeFileSync(path, `${PEM_HEADER}\nMIIB...\n${PEM_FOOTER}\n`);

    const issues = findSecretIssues([{ path, content: readFileSync(path, 'utf8') }]);
    expect(issues).toEqual([`${path}: private key material`]);
  });

  it('fails on a planted PGP private key block', () => {
    dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    const path = join(dir, 'key.asc');
    writeFileSync(path, `${PGP_HEADER}\nxYw...\n`);

    const issues = findSecretIssues([{ path, content: readFileSync(path, 'utf8') }]);
    expect(issues).toEqual([`${path}: private key material`]);
  });

  it('fails on a planted .env file', () => {
    dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    const path = join(dir, '.env');
    writeFileSync(path, 'DATABASE_URL=postgresql://x');

    const issues = findSecretIssues([{ path, content: readFileSync(path, 'utf8') }]);
    expect(issues).toEqual([`${path}: committed environment file`]);
  });

  it('fails on dash- or underscore-separated and reverse-order env file names', () => {
    const issues = findSecretIssues([
      { path: 'deploy/.env-prod', content: 'X=1' },
      { path: '.env_local', content: 'X=1' },
      { path: 'config/prod.env', content: 'X=1' },
    ]);
    expect(issues).toEqual([
      'deploy/.env-prod: committed environment file',
      '.env_local: committed environment file',
      'config/prod.env: committed environment file',
    ]);
  });

  it('does not flag the example env file or ordinary source', () => {
    const issues = findSecretIssues([
      { path: '.env.example', content: 'DATABASE_URL=' },
      { path: 'src/index.ts', content: 'export const x = 1;' },
      { path: 'src/env.ts', content: 'export const env = 1;' },
    ]);
    expect(issues).toEqual([]);
  });
});
