import { PrismaClient } from '@healer/prisma-client';

/**
 * The only place `apps/worker` may import `@healer/prisma-client` (`backend-nestjs.md`: confined
 * to `infrastructure/**`) — `main.ts` calls this instead of constructing `PrismaClient` itself.
 */
export function createPrismaClient(datasourceUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl });
}
