/**
 * Two callers raced a guarded write to the same graph row (rename, a version-minting
 * confirmation, an edge state change) and only one could legitimately win. Same shape as
 * `@healer/domain-issues`'s `ConcurrentModificationError` (001): the caller's own re-read and
 * retry is the correct response, not something this error attempts on the caller's behalf.
 */
export class GraphConcurrencyError extends Error {
  constructor(readonly resource: string) {
    super(`${resource} was modified concurrently — reread and retry`);
    this.name = 'GraphConcurrencyError';
  }
}
