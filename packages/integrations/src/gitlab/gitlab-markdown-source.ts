import type {
  RepositoryFileCommit,
  RepositoryMarkdownFile,
  RepositoryMarkdownSource,
} from '@healer/domain-knowledge';
import { isSafeRepoPath, isUnderPrefix } from './repo-path.js';

/** Largest markdown file read, in UTF-8 bytes (1 MiB). Over it is a typed error, never truncation. */
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

export interface GitlabTreeEntry {
  readonly path: string;
  /** Only `file` is ever listed; symlinks, submodules and directories are dropped. */
  readonly kind: 'file' | 'dir' | 'symlink' | 'submodule';
}

export interface RefOptions {
  /** The head sha resolved ONCE for this logical read; every call of the read carries it. */
  readonly ref: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Read-only seam for a runner-side GitLab client; no write method exists to call.
 *
 * PORT CONTRACT for `readFile`: the implementation MUST refuse before or while reading — check the
 * host-reported size first, and stop a streamed body at `maxBytes + 1` — and throw
 * `MarkdownFileTooLargeError`. It must never buffer an unbounded body, nor truncate. The source
 * re-checks the returned string as defence in depth; that post-check bounds nothing by itself.
 */
export interface GitlabMarkdownReader {
  /** The repository head sha, resolved once per logical read. */
  resolveRef(signal?: AbortSignal): Promise<string>;
  /** What `path` is AT `ref` (`missing` if absent). Symlinks must be reported as `symlink`. */
  entryKind(path: string, options: RefOptions): Promise<GitlabTreeEntry['kind'] | 'missing'>;
  listTree(prefix: string, options: RefOptions): Promise<readonly GitlabTreeEntry[]>;
  readFile(path: string, options: RefOptions & { readonly maxBytes: number }): Promise<string>;
  /** The host's own record of the last commit touching `path` AT `ref`. */
  lastCommitTouching(path: string, options: RefOptions): Promise<RepositoryFileCommit>;
}

export class UnsafeRepositoryPathError extends Error {
  constructor(readonly path: string) {
    super('repository path rejected (traversal, absolute, NUL, backslash or not markdown)');
    this.name = 'UnsafeRepositoryPathError';
  }
}

export class NotARegularFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'symlink' | 'submodule' | 'dir' | 'missing',
  ) {
    super(`repository path is not a regular file at the pinned ref (${reason})`);
    this.name = 'NotARegularFileError';
  }
}

export class PathOutsidePrefixError extends Error {
  constructor(readonly path: string) {
    super('repository path is outside the configured prefix');
    this.name = 'PathOutsidePrefixError';
  }
}

export class InvalidRepositoryPrefixError extends Error {
  constructor(readonly prefix: string) {
    super('repository prefix must be a non-empty safe relative directory');
    this.name = 'InvalidRepositoryPrefixError';
  }
}

export class MarkdownFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(`markdown file exceeds ${MAX_MARKDOWN_BYTES} bytes`);
    this.name = 'MarkdownFileTooLargeError';
  }
}

/** Closed list of why a tree entry was not listed (directories are structure, not skips). */
export type SkipReason =
  'symlink' | 'submodule' | 'unsafe_path' | 'outside_prefix' | 'not_markdown';

const isMarkdown = (path: string): boolean => path.endsWith('.md');

export class GitlabRepositoryMarkdownSource implements RepositoryMarkdownSource {
  private readonly prefix: string;

  constructor(
    private readonly reader: GitlabMarkdownReader,
    prefix: string,
    private readonly onSkipped?: (entry: GitlabTreeEntry, reason: SkipReason) => void,
  ) {
    const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    if (!isSafeRepoPath(dir)) throw new InvalidRepositoryPrefixError(prefix);
    this.prefix = dir;
  }

  async listMarkdown(signal?: AbortSignal): Promise<readonly string[]> {
    const ref = await this.reader.resolveRef(signal);
    const entries = await this.reader.listTree(this.prefix, { ref, signal });
    const out: string[] = [];
    for (const entry of entries) {
      const reason = this.skipReason(entry);
      if (reason === 'dir') continue;
      if (reason === undefined) out.push(entry.path);
      else this.onSkipped?.(entry, reason);
    }
    return out.sort();
  }

  async read(path: string, signal?: AbortSignal): Promise<RepositoryMarkdownFile> {
    if (!isSafeRepoPath(path) || !isMarkdown(path)) throw new UnsafeRepositoryPathError(path);
    if (!isUnderPrefix(this.prefix, path)) throw new PathOutsidePrefixError(path);
    const ref = await this.reader.resolveRef(signal);
    const kind = await this.reader.entryKind(path, { ref, signal });
    if (kind !== 'file') throw new NotARegularFileError(path, kind);
    const text = await this.reader.readFile(path, { ref, maxBytes: MAX_MARKDOWN_BYTES, signal });
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MARKDOWN_BYTES) throw new MarkdownFileTooLargeError(path, bytes);
    // Authorship and freshness come from the host's commit record at the SAME ref, never from `text`.
    const lastCommit = await this.reader.lastCommitTouching(path, { ref, signal });
    return { path, ref, text, lastCommit };
  }

  private skipReason(entry: GitlabTreeEntry): SkipReason | 'dir' | undefined {
    if (entry.kind === 'dir') return 'dir';
    if (entry.kind !== 'file') return entry.kind;
    if (!isSafeRepoPath(entry.path)) return 'unsafe_path';
    if (!isUnderPrefix(this.prefix, entry.path)) return 'outside_prefix';
    return isMarkdown(entry.path) ? undefined : 'not_markdown';
  }
}
