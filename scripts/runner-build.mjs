#!/usr/bin/env node
// `make runner-build` (012 T049/T050, FR-017, ADR 0014): builds apps/runner's Docker image, tags
// it `healer-runner:<version>` from apps/runner/package.json's own `version` field, and stamps
// apps/runner/dist/runner-release.json with `{ version, digest }` — the one file
// `runner-diagnostics` (a later task) and docker-compose.runner.yml both read.
//
// Builds to a throwaway candidate tag first, computes its digest, and only ever moves the real
// `healer-runner:<version>` tag onto it if doing so is safe (no previous image at that tag, or an
// identical rebuild) — the mechanism that makes FR-017's "a published version MUST NOT be rebuilt
// in place" a checked fact instead of a convention. A rebuild that reproduces the exact same
// digest is a legitimate no-op and is allowed; the *existing* tagged image is never disturbed on a
// refusal — the candidate is discarded and the real tag is never touched.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/harness.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCKERFILE = 'apps/runner/Dockerfile';
const DEFAULT_STAMP_PATH = fileURLToPath(
  new URL('../apps/runner/dist/runner-release.json', import.meta.url),
);

/** @param {string} pkgJsonText */
export function readRunnerVersion(pkgJsonText) {
  const pkg = JSON.parse(pkgJsonText);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('apps/runner/package.json has no version field');
  }
  return pkg.version;
}

/**
 * The one check behind FR-017's "must not be rebuilt in place" (ADR 0014). `previousDigest` is
 * `undefined` when no image exists at `tag` yet — a first release has nothing to protect.
 * @param {string} tag
 * @param {string | undefined} previousDigest
 * @param {string} newDigest
 */
export function assertNotRebuildInPlace(tag, previousDigest, newDigest) {
  if (previousDigest !== undefined && previousDigest !== newDigest) {
    throw new Error(
      `refusing to rebuild in place: ${tag} already exists at ${previousDigest}, this build ` +
        `produced ${newDigest}. A published runner version must not be rebuilt in place (FR-017)` +
        ` — bump apps/runner/package.json's version to publish a new artifact.`,
    );
  }
}

/* v8 ignore start -- real docker/fs calls; decision logic above is unit tested directly */
function tryInspectDigest(tag, repoRoot) {
  try {
    return execFileSync('docker', ['image', 'inspect', '--format={{.Id}}', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined; // no local image at this tag
  }
}

/**
 * @param {string} version
 * @param {{ repoRoot?: string, stampPath?: string }} [options] injectable for the e2e test —
 *   the CLI always uses the real repo root and stamp path; a test passes a throwaway version and
 *   stamp path so it never touches the real `apps/runner/dist/runner-release.json` or a real tag.
 * @returns {{ version: string, tag: string, digest: string }}
 */
export function runnerBuild(version, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const stampPath = options.stampPath ?? DEFAULT_STAMP_PATH;
  const tag = `healer-runner:${version}`;
  const candidateTag = `${tag}--candidate-${process.pid}-${Date.now()}`;

  const previousDigest = tryInspectDigest(tag, repoRoot);
  execFileSync('docker', ['build', '-t', candidateTag, '-f', DOCKERFILE, '.'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const newDigest = tryInspectDigest(candidateTag, repoRoot);
  if (newDigest === undefined) {
    throw new Error(`docker build reported success but ${candidateTag} cannot be inspected`);
  }

  try {
    assertNotRebuildInPlace(tag, previousDigest, newDigest);
  } catch (error) {
    execFileSync('docker', ['rmi', candidateTag], { cwd: repoRoot, stdio: 'ignore' });
    throw error;
  }

  // Safe: either the tag is new, or this rebuild reproduced the same digest already at `tag`.
  execFileSync('docker', ['tag', candidateTag, tag], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('docker', ['rmi', candidateTag], { cwd: repoRoot, stdio: 'ignore' });

  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify({ version, digest: newDigest }, null, 2)}\n`);

  return { version, tag, digest: newDigest };
}

if (isMainModule(import.meta.url)) {
  try {
    const version = readRunnerVersion(
      readFileSync(fileURLToPath(new URL('../apps/runner/package.json', import.meta.url)), 'utf8'),
    );
    const result = runnerBuild(version);
    process.stdout.write(
      `runner-build: ${result.tag} @ ${result.digest} — wrote ${DEFAULT_STAMP_PATH}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `runner-build failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
