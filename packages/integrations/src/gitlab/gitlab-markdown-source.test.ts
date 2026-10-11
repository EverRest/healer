import { describe, expect, it } from 'vitest';
import {
  GitlabRepositoryMarkdownSource,
  InvalidRepositoryPrefixError,
  MAX_MARKDOWN_BYTES,
  MarkdownFileTooLargeError,
  NotARegularFileError,
  PathOutsidePrefixError,
  UnsafeRepositoryPathError,
  type GitlabMarkdownReader,
  type GitlabTreeEntry,
  type SkipReason,
} from './gitlab-markdown-source.js';
import { isSafeRepoPath, isUnderPrefix } from './repo-path.js';

const HOST_COMMIT = {
  sha: 'abc123',
  authorRef: 'host-author',
  committedAt: new Date('2026-01-02'),
};

interface FakeOpts {
  entries?: GitlabTreeEntry[];
  text?: string;
  /** Head returned by successive resolveRef calls (moves if several given). */
  heads?: string[];
  /** Ignore maxBytes and return the string anyway (a misbehaving reader). */
  ignoreCap?: boolean;
  /** Kind of every path at read time (default: regular file). */
  kind?: GitlabTreeEntry['kind'] | 'missing';
}

/** Fake that ENFORCES the port contract (refuses over maxBytes) unless `ignoreCap`. */
function fake(o: FakeOpts = {}) {
  const heads = o.heads ?? ['head1'];
  let resolved = 0;
  const refsSeen: string[] = [];
  const reader: GitlabMarkdownReader = {
    resolveRef: () => Promise.resolve(heads[Math.min(resolved++, heads.length - 1)]!),
    entryKind: (_p, { ref }) => {
      refsSeen.push(ref);
      return Promise.resolve(o.kind ?? 'file');
    },
    listTree: (_p, { ref }) => {
      refsSeen.push(ref);
      return Promise.resolve(o.entries ?? []);
    },
    readFile: (path, { ref, maxBytes }) => {
      refsSeen.push(ref);
      const text = o.text ?? '# hi';
      if (!o.ignoreCap && Buffer.byteLength(text, 'utf8') > maxBytes) {
        return Promise.reject(new MarkdownFileTooLargeError(path, maxBytes + 1));
      }
      return Promise.resolve(text);
    },
    lastCommitTouching: (_p, { ref }) => {
      refsSeen.push(ref);
      return Promise.resolve({ ...HOST_COMMIT, sha: `last-at-${ref}` });
    },
  };
  return { reader, refsSeen };
}

const src = (
  o: FakeOpts = {},
  prefix = 'docs',
  onSkipped?: (e: GitlabTreeEntry, r: SkipReason) => void,
) => new GitlabRepositoryMarkdownSource(fake(o).reader, prefix, onSkipped);

describe('repo path safety', () => {
  it.each(['../x.md', 'a/../../x.md', '/etc/x.md', 'a\\b.md', 'a\0b.md', '', 'a//b.md', './a.md'])(
    'rejects %j',
    (p) => expect(isSafeRepoPath(p)).toBe(false),
  );
  it('accepts a plain relative path', () => expect(isSafeRepoPath('docs/a.md')).toBe(true));
  it('bounds by prefix at a segment boundary', () => {
    expect(isUnderPrefix('docs', 'docs/a.md')).toBe(true);
    expect(isUnderPrefix('docs/', 'docs/a.md')).toBe(true);
    expect(isUnderPrefix('docs', 'docs-evil/a.md')).toBe(false);
    expect(isUnderPrefix('docs', 'other/a.md')).toBe(false);
    expect(isUnderPrefix('../docs', '../docs/a.md')).toBe(false);
  });
});

describe('GitlabRepositoryMarkdownSource construction', () => {
  it.each(['../docs', '//', '', '/abs', 'a\\b', 'a/../b', '.'])('throws on prefix %j', (p) => {
    expect(() => src({}, p)).toThrow(InvalidRepositoryPrefixError);
  });
});

describe('GitlabRepositoryMarkdownSource', () => {
  const entries: GitlabTreeEntry[] = [
    { path: 'docs/b.md', kind: 'file' },
    { path: 'docs/a.md', kind: 'file' },
    { path: 'docs/a.txt', kind: 'file' },
    { path: 'docs/A.MD', kind: 'file' },
    { path: 'docs/link.md', kind: 'symlink' },
    { path: 'docs/sub.md', kind: 'submodule' },
    { path: 'docs/dir', kind: 'dir' },
    { path: 'docs/../secret.md', kind: 'file' },
    { path: 'elsewhere/c.md', kind: 'file' },
  ];

  it('lists sorted, .md only, prefix-bounded, files only', async () => {
    expect(await src({ entries }).listMarkdown()).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('reports every skip reason through onSkipped, without changing the listing', async () => {
    const skipped: [string, SkipReason][] = [];
    const out = await src({ entries }, 'docs', (e, r) => skipped.push([e.path, r])).listMarkdown();
    expect(out).toEqual(['docs/a.md', 'docs/b.md']);
    expect(skipped).toEqual(
      expect.arrayContaining([
        ['docs/link.md', 'symlink'],
        ['docs/sub.md', 'submodule'],
        ['docs/a.txt', 'not_markdown'],
        ['docs/A.MD', 'not_markdown'],
        ['docs/../secret.md', 'unsafe_path'],
        ['elsewhere/c.md', 'outside_prefix'],
      ]),
    );
    expect(skipped).toHaveLength(6);
  });

  it('rejects unsafe, non-markdown and out-of-prefix paths on read', async () => {
    const s = src();
    await expect(s.read('docs/../x.md')).rejects.toBeInstanceOf(UnsafeRepositoryPathError);
    await expect(s.read('docs/a.txt')).rejects.toBeInstanceOf(UnsafeRepositoryPathError);
    await expect(s.read('other/a.md')).rejects.toBeInstanceOf(PathOutsidePrefixError);
    await expect(s.read('docs-evil/a.md')).rejects.toBeInstanceOf(PathOutsidePrefixError);
  });

  it('takes the commit from the host, not from file text claiming otherwise', async () => {
    const lying = '---\nauthor: attacker\ncommit: deadbeef\ncommittedAt: 1999-01-01\n---\n# x';
    const file = await src({ text: lying }).read('docs/a.md');
    expect(file.lastCommit).toEqual({ ...HOST_COMMIT, sha: 'last-at-head1' });
    expect(file.text).toBe(lying);
  });

  it('pins one ref for a logical read even if the head moves', async () => {
    const f = fake({ heads: ['h1', 'h2', 'h3'] });
    const file = await new GitlabRepositoryMarkdownSource(f.reader, 'docs').read('docs/a.md');
    expect(file.ref).toBe('h1');
    expect(file.lastCommit.sha).toBe('last-at-h1');
    expect(new Set(f.refsSeen)).toEqual(new Set(['h1']));
    expect(f.refsSeen).toHaveLength(3);
  });

  it('pins one ref for a listing', async () => {
    const f = fake({ heads: ['h1', 'h2'], entries });
    await new GitlabRepositoryMarkdownSource(f.reader, 'docs').listMarkdown();
    expect(f.refsSeen).toEqual(['h1']);
  });

  it('passes maxBytes to the reader: an enforcing reader refuses over the cap', async () => {
    const over = 'x'.repeat(MAX_MARKDOWN_BYTES + 1);
    await expect(src({ text: over }).read('docs/a.md')).rejects.toBeInstanceOf(
      MarkdownFileTooLargeError,
    );
    const exact = 'x'.repeat(MAX_MARKDOWN_BYTES);
    expect((await src({ text: exact }).read('docs/a.md')).text).toBe(exact);
  });

  it('post-checks (defence in depth) when a reader returns an oversize string anyway', async () => {
    const over = 'x'.repeat(MAX_MARKDOWN_BYTES + 1);
    await expect(src({ text: over, ignoreCap: true }).read('docs/a.md')).rejects.toBeInstanceOf(
      MarkdownFileTooLargeError,
    );
    const multi = 'é'.repeat(MAX_MARKDOWN_BYTES / 2 + 1);
    await expect(src({ text: multi, ignoreCap: true }).read('docs/a.md')).rejects.toBeInstanceOf(
      MarkdownFileTooLargeError,
    );
  });

  it.each(['symlink', 'submodule', 'dir', 'missing'] as const)(
    'refuses to read a path whose kind at the ref is %s',
    async (kind) => {
      const err = await src({ kind })
        .read('docs/a.md')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotARegularFileError);
      expect((err as NotARegularFileError).reason).toBe(kind);
    },
  );

  it('catches a path that was a file when listed but is a symlink at read time', async () => {
    const o: FakeOpts = { entries: [{ path: 'docs/a.md', kind: 'file' }] };
    const s = src(o);
    expect(await s.listMarkdown()).toEqual(['docs/a.md']);
    o.kind = 'symlink';
    await expect(s.read('docs/a.md')).rejects.toBeInstanceOf(NotARegularFileError);
  });
});
