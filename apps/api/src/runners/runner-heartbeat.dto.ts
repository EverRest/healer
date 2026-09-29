import { z } from 'zod';

/**
 * `POST /runners/heartbeat` (012 T042, FR-018, FR-020): the same call serves registration and
 * every later heartbeat — `contracts/runner-protocol.md`'s registration table names
 * `protocolVersion`, `imageVersion`, `capabilities` and `resourceLimits`; FR-020's prose adds three
 * heartbeat-only fields with no schema of their own anywhere — `resourceState`, `clockOffsetMs`
 * and `lastSuccessfulTask` — accepted and validated here, but not persisted (QUESTIONS.md "012
 * phase 6, T042"). `resourceLimits` itself is accepted and validated but has no column either —
 * same treatment, same QUESTIONS.md entry.
 *
 * `name` is **not** in the contract document's own table, but `runner_registration` is unique on
 * `(tenantId, name)` (data-model.md) and nothing else in the payload identifies which registered
 * instance is calling — added here as the natural key the schema already requires (flagged in
 * QUESTIONS.md as a real gap in the contract document, not invented silently).
 *
 * `.strict()`: this is a control-plane-internal endpoint, not a provider webhook accepting
 * forward-compatible noise the way `/ingest/signals` does — an unrecognized field here is a
 * runner speaking a shape this control plane does not know, which should fail loudly.
 */
const resourceLimitsSchema = z
  .object({
    cpu: z.number().positive(),
    memoryMb: z.number().positive(),
    maxConcurrentRuns: z.number().int().positive(),
  })
  .strict();

export const runnerHeartbeatRequestSchema = z
  .object({
    name: z.string().min(1),
    protocolVersion: z.number().int().nonnegative(),
    imageVersion: z.string().min(1),
    capabilities: z.array(z.string()),
    resourceLimits: resourceLimitsSchema,
    // Heartbeat-only (FR-020), accepted and validated but not persisted (QUESTIONS.md): no
    // control-plane consumer reads them yet, so there is nothing to type strictly against beyond
    // "an object" / "a number" — `make runner-diagnostics` reads a runner's own resource state
    // from its local state, not from a second copy stored here.
    resourceState: z.record(z.string(), z.unknown()).optional(),
    clockOffsetMs: z.number().optional(),
    // No shape is defined anywhere for this either (spec.md FR-020 names it in prose only) —
    // accepted as loosely as `resourceState`, for the same reason.
    lastSuccessfulTask: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type RunnerHeartbeatRequest = z.infer<typeof runnerHeartbeatRequestSchema>;
