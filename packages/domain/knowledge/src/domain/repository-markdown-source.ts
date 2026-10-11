/**
 * The port the repository-markdown adapter implements (C-06, R-02, R-08). It lives in the domain so
 * `packages/integrations` depends on `knowledge`, never the reverse.
 *
 * Read-only by construction: there is no write method. Freshness and authorship are the repository's
 * own record of the last commit that touched the file — the caller cannot supply them, so neither can
 * a document claim them (T020, R-02).
 */
export interface RepositoryFileCommit {
  readonly sha: string;
  /** Commit author as the repository host records it — never read from the file body. */
  readonly authorRef: string;
  readonly committedAt: Date;
}

export interface RepositoryMarkdownFile {
  /** Repository-relative path; the document's `external_ref`. */
  readonly path: string;
  /**
   * The one revision (head sha) this file's text AND `lastCommit` were read at. `lastCommit.sha` is
   * the last commit touching the file at this ref — never data from a later head.
   */
  readonly ref: string;
  /** Raw file text. Untrusted data: the ingest wraps it before it goes anywhere (FR-026). */
  readonly text: string;
  /** The last commit touching this file at the ref that was read. */
  readonly lastCommit: RepositoryFileCommit;
}

export interface RepositoryMarkdownSource {
  /** Repository-relative markdown paths under the source's configured prefix, sorted. */
  listMarkdown(signal?: AbortSignal): Promise<readonly string[]>;
  read(path: string, signal?: AbortSignal): Promise<RepositoryMarkdownFile>;
}
