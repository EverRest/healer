// Execution-plane half of context resolution (003): collectors bound to local credentials, the
// redactor, the plane-local withholding ledger and egress validation. Nothing here is importable
// from the control plane — the runner is a separate image and this is the part that sees raw data.
export { collectPass, type CollectPassDeps } from './collect-pass.js';
export { egress, EgressRefusedError } from './egress.js';
export { Redactor } from './redaction/redactor.js';
export { FsWithholdingLedger, type LedgerEntry } from './withholding-ledger.js';
export {
  CollectorFailure,
  invocationFor,
  type Collector,
  type CollectorInvocation,
  type SourcePort,
} from './collectors/types.js';
export { configFlagsCollector } from './collectors/config-flags.js';
export { gitlabCommitsCollector } from './collectors/gitlab-commits.js';
export { lokiLogsCollector } from './collectors/loki-logs.js';
export { otelTracesCollector } from './collectors/otel-traces.js';
export { sourceFileCollector } from './collectors/source-file.js';
