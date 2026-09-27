import type { IssueSeverity } from './issue.js';

/**
 * One raw observation from a provider (contracts/openapi.yaml `Signal`), fingerprinted on
 * receipt (001 T018, FR-002). `errorSignature` mirrors T016's `FingerprintInput` free-text
 * fields; `component`/`environment` sit alongside it since they are hashed too but are the
 * caller's own identifiers, not volatile signal text.
 */
export interface ErrorSignature {
  readonly exceptionType?: string;
  readonly frames?: readonly string[];
  readonly endpointTemplate?: string;
  readonly errorCode?: string;
}

export interface Signal {
  /** Source clock (R-10) — ordering uses this, retention uses receipt time. */
  readonly observedAt: Date;
  readonly component: string;
  readonly environment: string;
  readonly severity?: IssueSeverity;
  readonly errorSignature: ErrorSignature;
  readonly traceId?: string;
  readonly deploymentRef?: string;
}
