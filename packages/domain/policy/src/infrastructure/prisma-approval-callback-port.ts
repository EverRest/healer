import type { PrismaClient } from '@healer/prisma-client';
import type { ApprovalCallbackPort } from '../domain/approval-callback-port.js';
import { deliverApprovalCallback } from './approval-run-effects.js';

/** The concrete delivery T045's sweep was waiting for: consumes the run's `approval` callback row
 *  (012 FR-030, idempotent — a repeat only counts). Waking the run is whatever steps it from its
 *  persisted state; no worker waits on this. */
export class PrismaApprovalCallbackPort implements ApprovalCallbackPort {
  constructor(private readonly prisma: PrismaClient) {}

  async deliver(input: {
    readonly tenantId: string;
    readonly workflowRunId: string;
    readonly approvalId: string;
  }): Promise<void> {
    await this.prisma.$transaction((tx) =>
      deliverApprovalCallback(tx, {
        tenantId: input.tenantId,
        runId: input.workflowRunId,
        now: new Date(),
      }),
    );
  }
}
