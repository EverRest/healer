#!/usr/bin/env node
// `secret-scan` runs first in `make ci` (012 T074, FR-008, FR-042): every later target
// reads the working tree, and a scan that runs after `build` has already had the chance
// to bake a secret into an artifact.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMainModule, runGate, reportAndExit } from './lib/harness.mjs';

// Matches PEM (`RSA PRIVATE KEY`), PKCS8 (bare `PRIVATE KEY`) and PGP armored
// (`PGP PRIVATE KEY BLOCK`) headers alike.
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
// `.env`, `.env.local`, `.env-prod`, `.env_local`, and a name that merely *ends* in `.env`
// such as `prod.env` — but not `.env.example`, matched below by exact basename.
const ENV_FILE_PATTERN = /(^|\/)(\.env([._-].*)?|[^/]+\.env)$/;
const ALLOWED_ENV_FILES = new Set(['.env.example', '.env.sample']);

/** @param {{ path: string, content?: string }[]} files */
export function findSecretIssues(files) {
  const issues = [];
  for (const { path, content } of files) {
    const base = path.split('/').pop() ?? path;
    if (ENV_FILE_PATTERN.test(path) && !ALLOWED_ENV_FILES.has(base)) {
      issues.push(`${path}: committed environment file`);
    }
    if (content !== undefined && PRIVATE_KEY_PATTERN.test(content)) {
      issues.push(`${path}: private key material`);
    }
  }
  return issues;
}

/* v8 ignore start -- CLI wiring (real git/fs I/O); findSecretIssues above is unit tested */
function trackedFilesWithContent() {
  // `-z` NUL-delimits entries so a path with a newline, quote or non-ASCII byte is not
  // shell-quoted by git and silently mismatched against ENV_FILE_PATTERN afterwards.
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  return paths.map((path) => {
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      content = undefined; // unreadable or binary: judged on path only
    }
    return { path, content };
  });
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('secret-scan', () => {
    const issues = findSecretIssues(trackedFilesWithContent());
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
