/**
 * The capability handshake (012 T039, T043, T044, FR-018, FR-020, R-03, C-02).
 *
 * A read-only gap degrades explicitly; a state-changing gap refuses — never degrades, because a
 * mutation executed by older runner logic without warning is the failure this product cannot
 * have (runner-protocol.md). Persisting the resolution to `runner_capability_resolution` and the
 * registration to `runner_registration` is the control plane's job once a repository exists for
 * them (001's pattern); this module is the pure decision the persistence layer then records.
 */
export const CURRENT_PROTOCOL_VERSION = 1;
export const PROTOCOL_FLOOR_MINOR_VERSIONS = 2;
export const PROTOCOL_FLOOR_DAYS = 90;

export interface RunnerHandshake {
  readonly protocolVersion: number;
  readonly imageVersion: string;
  readonly capabilities: readonly string[];
  readonly resourceLimits: {
    readonly cpu: number;
    readonly memoryMb: number;
    readonly maxConcurrentRuns: number;
  };
}

export interface CapabilityRequirement {
  readonly name: string;
  readonly kind: 'read' | 'write';
}

export type HandshakeStatus = 'active' | 'degraded' | 'refused';
export type CapabilityOutcome = 'available' | 'degraded' | 'refused';

export interface CapabilityResolution {
  readonly capability: string;
  readonly outcome: CapabilityOutcome;
  readonly reason?: string;
}

export interface HandshakeResult {
  readonly status: HandshakeStatus;
  readonly resolvedCapabilities: readonly string[];
  readonly resolutions: readonly CapabilityResolution[];
  readonly refusedReason?: string;
}

export interface HandshakeDeps {
  readonly currentProtocolVersion?: number;
  /**
   * When known, the calendar date a protocol version *shipped* — used to find when a version was
   * superseded (the release date of `version + 1`), never to age the runner's own current
   * version. Ageing a version by its own release date would refuse every runner still on the
   * current version 90 days after every release, with nothing newer to upgrade to.
   */
  readonly protocolReleasedAt?: (version: number) => Date;
  readonly now?: Date;
}

function refused(reason: string): HandshakeResult {
  return { status: 'refused', resolvedCapabilities: [], resolutions: [], refusedReason: reason };
}

export function resolveHandshake(
  handshake: RunnerHandshake,
  requirements: readonly CapabilityRequirement[],
  deps: HandshakeDeps = {},
): HandshakeResult {
  const currentProtocolVersion = deps.currentProtocolVersion ?? CURRENT_PROTOCOL_VERSION;
  const versionsBehind = currentProtocolVersion - handshake.protocolVersion;
  if (versionsBehind > PROTOCOL_FLOOR_MINOR_VERSIONS) {
    return refused(
      `protocol version ${handshake.protocolVersion} is ${versionsBehind} minor versions behind ` +
        `current (${currentProtocolVersion}), over the ${PROTOCOL_FLOOR_MINOR_VERSIONS}-version floor — upgrade required (C-02)`,
    );
  }

  // The day-based floor only makes sense for a version that has been superseded — the current
  // version is never "too old" by this check, however long it has been the current one.
  if (deps.protocolReleasedAt && handshake.protocolVersion !== currentProtocolVersion) {
    const now = deps.now ?? new Date();
    const supersededAt = deps.protocolReleasedAt(handshake.protocolVersion + 1);
    const ageDays = (now.getTime() - supersededAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > PROTOCOL_FLOOR_DAYS) {
      return refused(
        `protocol version ${handshake.protocolVersion} was superseded ${Math.floor(ageDays)} days ago, ` +
          `over the ${PROTOCOL_FLOOR_DAYS}-day floor — upgrade required (C-02)`,
      );
    }
  }

  const declared = new Set(handshake.capabilities);
  const resolutions: CapabilityResolution[] = requirements.map((req) => {
    if (declared.has(req.name)) return { capability: req.name, outcome: 'available' };
    if (req.kind === 'read') {
      return {
        capability: req.name,
        outcome: 'degraded',
        reason: `runner does not declare ${req.name}`,
      };
    }
    // Read-only degrades; a state-changing gap never does (runner-protocol.md compatibility table).
    return {
      capability: req.name,
      outcome: 'refused',
      reason: `runner does not declare required write capability ${req.name}`,
    };
  });

  const refusal = resolutions.find((r) => r.outcome === 'refused');
  const status: HandshakeStatus = refusal
    ? 'refused'
    : resolutions.some((r) => r.outcome === 'degraded')
      ? 'degraded'
      : 'active';

  return {
    status,
    resolvedCapabilities: resolutions
      .filter((r) => r.outcome === 'available')
      .map((r) => r.capability),
    resolutions,
    ...(refusal ? { refusedReason: refusal.reason } : {}),
  };
}
