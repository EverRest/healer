import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CollectorKey,
  DetectorKey,
  GapReasonCode,
  ItemClass,
} from '@healer/boundary-contract';

/**
 * The plane-local withholding ledger (003 T003, T020, FR-009, R-08). It lives on the customer's
 * storage under the customer's retention and is **never replicated to the control plane**: the
 * only thing that crosses is the `localRef`, an opaque UUID the control plane is structurally
 * unable to dereference — there is no endpoint, table or function on its side that accepts one.
 *
 * A file per entry, mode 0600, named by the UUID: no database, no new dependency, nothing a
 * network listener could serve (the runner is outbound-only, 012 T045), and a human resolves it
 * with `make runner-resolve-ref <uuid>`.
 */
export interface LedgerEntryInput {
  /** `withheld`: nothing crossed. `reduced`: an excerpt/shape crossed, the original stays here. */
  readonly kind: 'withheld' | 'reduced';
  readonly collectorKey: CollectorKey;
  readonly itemClass: ItemClass;
  readonly reasonCode?: GapReasonCode;
  readonly detector?: DetectorKey;
  /** Where in the source the original lives — enough for a human to find it again. */
  readonly sourceLocator: string;
  readonly original: string;
  readonly observedAt: Date;
}

export interface LedgerEntry extends Omit<LedgerEntryInput, 'observedAt'> {
  readonly localRef: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly originalTruncated: boolean;
}

/** A 40 MB heap dump is referenced, not copied: the stored original is bounded (FR-013). */
export const LEDGER_ORIGINAL_MAX_CHARS = 1_000_000;
/** Placeholder pending the customer's own retention policy (spec assumptions: configuration). */
export const DEFAULT_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default location under the runner's temp area; `RUNNER_LEDGER_DIR` overrides it (resolve script and runner alike). */
export const LEDGER_DIR_NAME = 'healer-runner-ledger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FsWithholdingLedger {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly retentionMs: number = DEFAULT_LEDGER_RETENTION_MS,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  record(input: LedgerEntryInput): { localRef: string } {
    const localRef = randomUUID();
    const truncated = input.original.length > LEDGER_ORIGINAL_MAX_CHARS;
    const entry: LedgerEntry = {
      ...input,
      localRef,
      original: truncated ? input.original.slice(0, LEDGER_ORIGINAL_MAX_CHARS) : input.original,
      originalTruncated: truncated,
      observedAt: input.observedAt.toISOString(),
      expiresAt: new Date(this.now().getTime() + this.retentionMs).toISOString(),
    };
    writeFileSync(this.fileFor(localRef), JSON.stringify(entry), { mode: 0o600 });
    return { localRef };
  }

  resolve(localRef: string): LedgerEntry | undefined {
    // The reference is a UUID or it is nothing: it is never used as a path fragment unchecked.
    if (!UUID.test(localRef)) return undefined;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(readFileSync(this.fileFor(localRef), 'utf8')) as LedgerEntry;
    } catch {
      return undefined;
    }
    return Date.parse(entry.expiresAt) > this.now().getTime() ? entry : undefined;
  }

  pruneExpired(): number {
    let pruned = 0;
    for (const file of readdirSync(this.dir)) {
      const ref = file.replace(/\.json$/, '');
      if (!UUID.test(ref) || this.resolve(ref) !== undefined) continue;
      rmSync(join(this.dir, file), { force: true });
      pruned += 1;
    }
    return pruned;
  }

  private fileFor(localRef: string): string {
    return join(this.dir, `${localRef}.json`);
  }
}
