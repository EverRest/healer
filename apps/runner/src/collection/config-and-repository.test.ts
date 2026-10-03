import { describe, expect, it } from 'vitest';
import { collectPass } from './collect-pass.js';
import { configFlagsCollector } from './collectors/config-flags.js';
import { gitlabCommitsCollector } from './collectors/gitlab-commits.js';
import { sourceFileCollector } from './collectors/source-file.js';
import { ControlPlaneDirective } from '@healer/boundary-contract';
import { depsFor, planFor, sourceOf } from './test-support.js';

const T = '2026-01-01T00:30:00Z';

describe('configuration and feature flags cross as keys and shapes only (003 T023, T024, FR-007, quickstart 4)', () => {
  const VALUES = [
    'hunter2-config-secret',
    'sk-live-ABCDEFGHIJKLMNOPQRSTUV',
    'postgres://u:pw@h/db',
    'true-ish',
  ];
  const records = [
    { keyPath: 'db.password', value: VALUES[0], changedAt: T, locator: 'c1' },
    { keyPath: 'stripe.api_key', value: VALUES[1], locator: 'c2' },
    { keyPath: 'db.url', value: VALUES[2], locator: 'c3' },
    { keyPath: 'flags.new_checkout', value: true, locator: 'c4' },
    { keyPath: 'flags.retired', locator: 'c5' },
    { keyPath: 'limits', value: { max: 5 }, locator: 'c6' },
  ];

  it('emits config_key_ref — key path, component, environment, presence, type, length class — and no value', async () => {
    const batch = await collectPass(
      planFor(['config_flags']),
      depsFor({ config_flags: configFlagsCollector(sourceOf(records)) }),
    );
    const refs = batch.items.map((i) => i.evidence);
    expect(refs.every((e) => e.kind === 'config_key_ref')).toBe(true);
    expect(refs[0]).toEqual({
      kind: 'config_key_ref',
      keyPath: 'db.password',
      component: 'api',
      environment: 'production',
      presence: 'present',
      type: 'string',
      lengthClass: 'medium',
    });
    expect(refs[3]).toMatchObject({ presence: 'present', type: 'boolean' });
    expect(refs[4]).toMatchObject({ presence: 'absent', type: 'undefined' });
    expect(refs[5]).toMatchObject({ type: 'object' });
    const bytes = JSON.stringify(batch);
    for (const value of VALUES.slice(0, 3)) expect(bytes).not.toContain(value);
    expect(bytes).not.toContain('hunter2');
  });

  it('never rides as tool_output_summary, and carries no excerpt at all', async () => {
    const batch = await collectPass(
      planFor(['config_flags']),
      depsFor({ config_flags: configFlagsCollector(sourceOf(records)) }),
    );
    expect(batch.items.some((i) => i.evidence.kind === 'tool_output_summary')).toBe(false);
    expect(batch.items.every((i) => i.excerpt === undefined)).toBe(true);
  });

  it('withholds a key whose name is not a key path, rather than guessing', async () => {
    const batch = await collectPass(
      planFor(['config_flags']),
      depsFor({
        config_flags: configFlagsCollector(
          sourceOf([{ keyPath: 'password is hunter2', value: 1, locator: 'x' }]),
        ),
      }),
    );
    expect(batch.items.map((i) => i.evidence.kind)).toEqual(['collection_gap']);
    expect(JSON.stringify(batch)).not.toContain('hunter2');
  });
});

describe('a repository crosses as paths and metadata, never content (003 T025, T026, FR-011, quickstart 5, 6)', () => {
  const commit = {
    sha: '3f9a6b2c1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70',
    authorHandle: 'jdoe',
    committedAt: T,
    changedPaths: ['src/billing/charge.ts', 'src/api/users.ts'],
    message: 'rotate key AKIAABCDEFGHIJKLMNOP',
    diff: '+const secret = "DIFF-BODY-MARKER"',
    locator: 'gl:1',
  };

  it('commit_ref carries sha, author handle, time and changed paths — not the message or the diff', async () => {
    const batch = await collectPass(
      planFor(['gitlab_commits']),
      depsFor({ gitlab_commits: gitlabCommitsCollector(sourceOf([commit])) }),
    );
    expect(batch.items[0]!.evidence).toEqual({
      kind: 'commit_ref',
      sha: commit.sha,
      // a handle is a person: it crosses as a stable per-tenant pseudonym
      authorHandle: expect.stringMatching(/^h_[0-9a-f]{8}$/),
      occurredAt: T,
      changedPaths: commit.changedPaths,
    });
    const bytes = JSON.stringify(batch);
    expect(bytes).not.toContain('AKIA');
    expect(bytes).not.toContain('DIFF-BODY-MARKER');
    expect(batch.items[0]!.excerpt).toBeUndefined();
  });

  it('source_file emits the path of an existing file and nothing of its content', async () => {
    const files = [
      { path: 'src/a.ts', exists: true, content: 'FILE-BODY-MARKER', locator: 'f1' },
      { path: 'src/gone.ts', exists: false, locator: 'f2' },
    ];
    const batch = await collectPass(
      planFor(['source_file'], {
        passOrdinal: 1,
        requestedByStep: 'investigator',
        requestReason: 'inspect_stack_frame_source',
      }),
      depsFor({ source_file: sourceFileCollector(sourceOf(files)) }),
    );
    expect(batch.items.map((i) => i.evidence)).toEqual([{ kind: 'file_path', path: 'src/a.ts' }]);
    expect(JSON.stringify(batch)).not.toContain('FILE-BODY-MARKER');
  });

  it('source_file is reachable only as a follow-up pass — pass 0 cannot carry it (R-12)', () => {
    expect(ControlPlaneDirective.safeParse(planFor(['source_file'])).success).toBe(false);
    expect(
      ControlPlaneDirective.safeParse(
        planFor(['source_file'], {
          passOrdinal: 1,
          requestedByStep: 'investigator',
          requestReason: 'inspect_stack_frame_source',
        }),
      ).success,
    ).toBe(true);
  });
});
