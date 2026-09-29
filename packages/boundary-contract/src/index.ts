import { z } from 'zod';
import {
  componentCandidate,
  deploymentUnitCandidate,
  dependencyObservation,
  repositoryRef,
} from './discovery-shapes.js';

/**
 * The closed evidence shape set that may cross the control/execution boundary (012 T040, R-04,
 * contracts/runner-protocol.md). Every schema is `.strict()`: an unknown key — the free-form
 * field this contract exists to close off — is a validation failure, not a passthrough. A new
 * fact family is a new row in the contract document plus a new schema here, reviewed like the
 * rest of it (C-20); it never rides inside `toolOutputSummary`, the one shape most tempted to
 * become a general-purpose escape hatch.
 */

const path = z.string().min(1);
const isoTimestamp = z.string().datetime({ offset: true });

// ─────────────────────────── runner → control plane ───────────────────────────

const errorSignature = z
  .object({
    kind: z.literal('error_signature'),
    exceptionType: z.string(),
    frames: z.array(z.string()),
    component: z.string(),
    environment: z.string(),
  })
  .strict();

const traceShape = z
  .object({
    kind: z.literal('trace_shape'),
    spans: z.array(
      z
        .object({
          name: z.string(),
          durationMs: z.number().nonnegative(),
          serviceEdge: z.string(),
          statusCode: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const metricDelta = z
  .object({
    kind: z.literal('metric_delta'),
    seriesId: z.string(),
    window: z.string(),
    baseline: z.number(),
    observed: z.number(),
    direction: z.enum(['up', 'down']),
  })
  .strict();

const deployRef = z
  .object({
    kind: z.literal('deploy_ref'),
    deploymentId: z.string(),
    version: z.string(),
    occurredAt: isoTimestamp,
    component: z.string(),
  })
  .strict();

const commitRef = z
  .object({
    kind: z.literal('commit_ref'),
    sha: z.string(),
    authorHandle: z.string(),
    occurredAt: isoTimestamp,
    changedPaths: z.array(path),
  })
  .strict();

const testResult = z
  .object({
    kind: z.literal('test_result'),
    testId: z.string(),
    outcome: z.enum(['pass', 'fail', 'skip']),
    durationMs: z.number().nonnegative(),
    failureSignature: z.string().optional(),
  })
  .strict();

const filePath = z
  .object({
    kind: z.literal('file_path'),
    path,
  })
  .strict();

// Declared fields only — a value here is whatever the tool's own declared field is, never a
// free-form message; this is not the general-purpose escape hatch (C-20). Bounded on both axes
// (value length, key count) so a raw log body or source excerpt cannot be smuggled through under
// a plausible-looking field name — an unbounded string here would be exactly that escape hatch.
const MAX_TOOL_OUTPUT_FIELD_LENGTH = 500;
const MAX_TOOL_OUTPUT_FIELDS = 20;

const toolOutputSummary = z
  .object({
    kind: z.literal('tool_output_summary'),
    toolName: z.string(),
    outcome: z.string(),
    fields: z
      .record(
        z.string(),
        z.union([z.string().max(MAX_TOOL_OUTPUT_FIELD_LENGTH), z.number(), z.boolean()]),
      )
      .refine((fields) => Object.keys(fields).length <= MAX_TOOL_OUTPUT_FIELDS, {
        message: `fields may declare at most ${MAX_TOOL_OUTPUT_FIELDS} keys`,
      }),
  })
  .strict();

const collectionGap = z
  .object({
    kind: z.literal('collection_gap'),
    what: z.string(),
    why: z.string(),
    withheldByRedaction: z.boolean(),
  })
  .strict();

const pullRequestRef = z
  .object({
    kind: z.literal('pull_request_ref'),
    pullRequestId: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    state: z.string(),
    reviewState: z.string(),
    authorHandle: z.string(),
    occurredAt: isoTimestamp,
    changedPaths: z.array(path),
  })
  .strict();

const configKeyRef = z
  .object({
    kind: z.literal('config_key_ref'),
    keyPath: z.string(),
    component: z.string(),
    environment: z.string(),
    presence: z.enum(['present', 'absent']),
    type: z.string(),
    lengthClass: z.string(),
  })
  .strict();

const knowledgeRef = z
  .object({
    kind: z.literal('knowledge_ref'),
    documentId: z.string(),
    path,
    sectionAnchor: z.string(),
    contentDigest: z.string(),
    revision: z.string(),
    authorshipClass: z.enum(['human', 'machine', 'machine_adopted']),
    observedAt: isoTimestamp,
  })
  .strict();

// `file_path` carries a path alone; a frame is a path plus where in it — conflating the two
// would let a symbol name ride inside a shape declared "path only" (runner-protocol.md).
const stackFrame = z
  .object({
    kind: z.literal('stack_frame'),
    path,
    symbolName: z.string(),
    line: z.number().int().positive(),
    frameIndex: z.number().int().nonnegative(),
  })
  .strict();

const changePlanProposal = z
  .object({
    kind: z.literal('change_plan_proposal'),
    primaryFiles: z.array(path),
    dependentFiles: z.array(path),
    testPaths: z.array(path),
    impactClass: z.string(),
    expectedBehaviorRef: z.string(),
  })
  .strict();

const MASKING_CLASSES = ['secret', 'credential', 'customer_data', 'unclassifiable'] as const;

const maskingCandidate = z
  .object({
    kind: z.literal('masking_candidate'),
    path,
    hunkLineRange: z
      .object({ start: z.number().int().positive(), end: z.number().int().positive() })
      .strict(),
    maskingClass: z.enum(MASKING_CLASSES),
  })
  .strict();

const verificationVerdict = z
  .object({
    kind: z.literal('verification_verdict'),
    verdict: z.string(),
    anchorsAvailable: z.array(z.string()),
    anchorsUsed: z.array(z.string()),
  })
  .strict();

const testBindingRef = z
  .object({
    kind: z.literal('test_binding_ref'),
    testId: z.string(),
    path,
    expectationId: z.string(),
    expectationVersion: z.number().int().nonnegative(),
  })
  .strict();

const agentRunReport = z
  .object({
    kind: z.literal('agent_run_report'),
    agentKind: z.enum(['investigator', 'change', 'verifier', 'support', 'test_author']),
    modelId: z.string(),
    provider: z.string(),
    promptVersionId: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    toolCalls: z.array(
      z.object({ name: z.string(), argumentDigest: z.string(), outcome: z.string() }).strict(),
    ),
    decisionPathStepIds: z.array(z.string()),
    outcome: z.string(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const CHANGE_GRAPH_DERIVATIONS = [
  'ast',
  'type_graph',
  'call_graph',
  'contract',
  'migration',
  'test',
  'event_consumer',
  'feature_flag',
] as const;

const changeGraph = z
  .object({
    kind: z.literal('change_graph'),
    nodes: z.array(z.object({ path, symbolName: z.string().optional() }).strict()),
    edges: z.array(
      z
        .object({
          from: z.string(),
          to: z.string(),
          relation: z.string(),
          derivation: z.enum(CHANGE_GRAPH_DERIVATIONS),
        })
        .strict(),
    ),
  })
  .strict();

export const RunnerEvidence = z.discriminatedUnion('kind', [
  errorSignature,
  traceShape,
  metricDelta,
  deployRef,
  commitRef,
  testResult,
  filePath,
  toolOutputSummary,
  collectionGap,
  componentCandidate,
  deploymentUnitCandidate,
  dependencyObservation,
  repositoryRef,
  pullRequestRef,
  configKeyRef,
  knowledgeRef,
  stackFrame,
  changePlanProposal,
  maskingCandidate,
  verificationVerdict,
  testBindingRef,
  agentRunReport,
  changeGraph,
]);

export type RunnerEvidence = z.infer<typeof RunnerEvidence>;

// ─────────────────────────── control plane → runner ───────────────────────────

const collectionPlan = z
  .object({
    kind: z.literal('collection_plan'),
    collectors: z.array(z.string()),
    window: z.string(),
    componentRefs: z.array(z.string()),
  })
  .strict();

const reproductionDirective = z
  .object({
    kind: z.literal('reproduction_directive'),
    rung: z.string(),
    target: z.string(),
    testCommand: z.string(),
    limits: z.object({ wallClockMs: z.number().int().positive() }).strict(),
  })
  .strict();

const agentDirective = z
  .object({
    kind: z.literal('agent_directive'),
    agentKind: z.enum(['investigator', 'change', 'verifier', 'support', 'test_author']),
    promptVersionId: z.string(),
    promptDigest: z.string(),
    inputRefs: z
      .object({
        issueRef: z.string().optional(),
        diagnosisRef: z.string().optional(),
        reproductionRef: z.string().optional(),
        anchorRef: z.string().optional(),
      })
      .strict(),
    budget: z
      .object({
        tokens: z.number().int().positive(),
        cost: z.number().positive(),
        wallClockMs: z.number().int().positive(),
      })
      .strict(),
    toolScope: z.array(z.string()),
  })
  .strict();

// The runner refuses this unless its digest matches the directive's `promptDigest` (FR-038,
// FR-039) — enforced by the runner at the point it's applied, not by this schema, which only
// closes the shape.
const promptVersionDirective = z
  .object({
    kind: z.literal('prompt_version'),
    promptVersionId: z.string(),
    digest: z.string(),
    body: z.string(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

const changePlanDirective = z
  .object({
    kind: z.literal('change_plan'),
    filesPermitted: z.array(path),
    regressionTestLocation: path,
    anchorRef: z.string(),
    limits: z.object({ wallClockMs: z.number().int().positive() }).strict(),
  })
  .strict();

const remediationDirective = z
  .object({
    kind: z.literal('remediation_directive'),
    actionKey: z.string(),
    target: z.string(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

const capabilityQuery = z
  .object({
    kind: z.literal('capability_query'),
    requested: z.array(z.string()),
  })
  .strict();

export const ControlPlaneDirective = z.discriminatedUnion('kind', [
  collectionPlan,
  reproductionDirective,
  agentDirective,
  promptVersionDirective,
  changePlanDirective,
  remediationDirective,
  capabilityQuery,
]);

export type ControlPlaneDirective = z.infer<typeof ControlPlaneDirective>;

// The wire shape a heartbeat response carries a pending directive in (012 T045, T051, FR-028).
// `ControlPlaneDirective`'s own seven variants carry no identifier field — a real gap between
// runner-protocol.md's prose ("idempotent by directive identifier") and this schema, recorded in
// QUESTIONS.md rather than widened into the closed union itself. This envelope is the one
// authority for the id both sides of the boundary need to agree on (FR-022, AGENTS.md "a closed
// list has exactly one authority") — the control plane's heartbeat response and the runner's
// dispatcher must type against this same schema, not two independently-guessed shapes.
export const DirectiveEnvelope = z
  .object({
    id: z.string().min(1),
    directive: ControlPlaneDirective,
  })
  .strict();

export type DirectiveEnvelope = z.infer<typeof DirectiveEnvelope>;

// A session opened for a simulation run (011, C-10): no `remediation_directive`, and
// `agent_directive` only for `change`/`verifier` kinds, all scoped to a sandbox workspace that
// is destroyed when the run ends and holds no repository-write capability (ADR 0008).
export function isPermittedInSimulationSession(directive: ControlPlaneDirective): boolean {
  if (directive.kind === 'remediation_directive') return false;
  if (directive.kind === 'agent_directive') {
    return directive.agentKind === 'change' || directive.agentKind === 'verifier';
  }
  return true;
}

export * from './handshake.js';
export * from './runner-registration.js';
export * from './validation.js';
export * from './outbound-buffer.js';
export * from './redaction.js';
export * from './tool-call-digest.js';
export * from './byo-fallback-check.js';
export * from './discovery-shapes.js';
