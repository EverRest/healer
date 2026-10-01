/**
 * T045: "deliver the approval callback, so a parked run moves to `needs_human` immediately."
 * 012's callback registry (`packages/workflow/src/callbacks.ts`) is pure domain logic with no
 * Prisma-backed delivery mechanism wired to any app yet, and no scheduler exists anywhere in
 * this repository to run a sweep periodically (001's own staleness sweep has the identical gap —
 * QUESTIONS.md "001 T051"). This port is the boundary `sweepRevokedApprovals` calls through, so
 * the sweep's own guarantee (the request is marked `revoked` and the decision invalidated) does
 * not wait on that infrastructure landing — a caller wires a real implementation once 012 builds
 * one.
 */
export interface ApprovalCallbackPort {
  deliver(input: {
    readonly tenantId: string;
    readonly workflowRunId: string;
    readonly approvalId: string;
  }): Promise<void>;
}
