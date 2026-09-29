import { z } from 'zod';
import { DirectiveEnvelope } from '@healer/boundary-contract';
import type { RunnerConfig } from '@healer/shared';

/**
 * The runner's one outbound call (012 T045, contracts/runner-protocol.md "Direction and
 * initiation"): `POST /runners/heartbeat`, matching `apps/api/src/runners/runner-heartbeat.dto.ts`
 * exactly, including the `name` field the contract document itself doesn't list yet (QUESTIONS.md
 * "012 phase 6, T042" already flags that gap — not repeated here).
 */
export interface HeartbeatRequestBody {
  readonly name: string;
  readonly protocolVersion: number;
  readonly imageVersion: string;
  readonly capabilities: readonly string[];
  readonly resourceLimits: {
    readonly cpu: number;
    readonly memoryMb: number;
    readonly maxConcurrentRuns: number;
  };
}

export function buildHeartbeatPayload(config: RunnerConfig): HeartbeatRequestBody {
  return {
    name: config.RUNNER_NAME,
    protocolVersion: config.RUNNER_PROTOCOL_VERSION,
    imageVersion: config.RUNNER_IMAGE_VERSION,
    capabilities: config.RUNNER_CAPABILITIES,
    resourceLimits: {
      cpu: config.RUNNER_CPU_LIMIT,
      memoryMb: config.RUNNER_MEMORY_MB_LIMIT,
      maxConcurrentRuns: config.RUNNER_MAX_CONCURRENT_RUNS,
    },
  };
}

// Directives arrive via this same heartbeat response, not a second inbound channel
// (QUESTIONS.md "012 phase 6") — `RunnersController` sends `directives: []` today (no producer
// exists yet), which trivially satisfies this array schema. Independent ingress validation on the
// runner side, mirroring FR-022's "validated ... independently at ingress" for evidence going the
// other way. `DirectiveEnvelope` is imported from `@healer/boundary-contract`, not redefined here
// — the one authority both sides of the boundary must agree on (review finding: a locally-defined
// copy here would silently drift from whatever a real producer, following the contract package
// instead, actually sends).
const heartbeatResponseSchema = z.object({
  status: z.enum(['active', 'degraded', 'refused']),
  resolvedCapabilities: z.array(z.string()),
  refusedReason: z.string().optional(),
  directives: z.array(DirectiveEnvelope),
});

export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export class HeartbeatTransportError extends Error {}

/** A hung control plane must not pile up ticks indefinitely — bounded to a fraction of the
 *  heartbeat interval so a stuck request is abandoned well before the next tick would fire anyway,
 *  with a floor so a very short configured interval still leaves the request a fair chance. */
const HEARTBEAT_TIMEOUT_FRACTION = 0.5;
const MIN_HEARTBEAT_TIMEOUT_MS = 1_000;

/**
 * POSTs one heartbeat. Never opens a listening socket — this function only ever initiates an
 * outbound request; there is nothing here for the customer's network to connect into. `fetchImpl`
 * defaults to the platform's native `fetch` (no new HTTP client dependency) and is a parameter
 * purely so a test can supply a fake one instead of a real network call.
 */
export async function sendHeartbeat(
  config: RunnerConfig,
  payload: HeartbeatRequestBody,
  fetchImpl: typeof fetch = fetch,
): Promise<HeartbeatResponse> {
  const timeoutMs = Math.max(
    MIN_HEARTBEAT_TIMEOUT_MS,
    Math.floor(config.RUNNER_HEARTBEAT_INTERVAL_MS * HEARTBEAT_TIMEOUT_FRACTION),
  );
  let response: Response;
  try {
    response = await fetchImpl(`${config.RUNNER_CONTROL_PLANE_URL}/runners/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': config.RUNNER_TENANT_ID },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HeartbeatTransportError(
      `heartbeat POST failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new HeartbeatTransportError(`heartbeat POST returned ${response.status}`);
  }

  const body: unknown = await response.json();
  const parsed = heartbeatResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HeartbeatTransportError(
      `heartbeat response failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
