import * as prismaClient from '@healer/prisma-client';
import { ConcurrentModificationError } from '../domain/state-machine.js';

const makeError = () => new ConcurrentModificationError('Issue');

/**
 * Issue-flavoured wrapper over `@healer/prisma-client`'s concurrency-conflict detection (shared
 * so `@healer/domain-architecture` can reuse the same SQLSTATE/Prisma-error-code logic without
 * duplicating it — see 004 QUESTIONS.md). The detection lives there; only the resulting error type
 * is issue-specific.
 */
export function translateConcurrencyError(error: unknown): unknown {
  return prismaClient.translateConcurrencyError(error, makeError);
}

export async function withConcurrencyTranslation<T>(fn: () => Promise<T>): Promise<T> {
  return prismaClient.withConcurrencyTranslation(fn, makeError);
}
