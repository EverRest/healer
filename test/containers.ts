import { readFileSync } from 'node:fs';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * Disposable Postgres and Redis for e2e tests (012 T003, R-12).
 *
 * Not a shared development database: tenant-isolation tests create two tenants and assert
 * one cannot see the other, and on a shared database those tests are order-dependent and
 * quietly flaky. Flaky is worse than slow here, because 008 forbids a flaky result from
 * counting as proof.
 */
export interface StartedPostgres {
  readonly url: string;
  readonly container: StartedTestContainer;
  stop(): Promise<void>;
}

const PG_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: 'healer',
      POSTGRES_PASSWORD: 'healer',
      POSTGRES_DB: 'healer',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const url = `postgresql://healer:healer@${container.getHost()}:${container.getMappedPort(5432)}/healer`;
  return {
    url,
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Runs a SQL file inside the container, so no client dependency is needed to migrate. */
export async function applySqlFile(pg: StartedPostgres, path: string): Promise<void> {
  const sql = readFileSync(path, 'utf8');
  const result = await pg.container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'healer',
    '-d',
    'healer',
    '-c',
    sql,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`psql failed applying ${path}: ${result.output}`);
  }
}

export async function query(pg: StartedPostgres, sql: string): Promise<string> {
  const result = await pg.container.exec([
    'psql',
    '-tAX',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'healer',
    '-d',
    'healer',
    '-c',
    sql,
  ]);
  if (result.exitCode !== 0) throw new Error(`psql failed: ${result.output}`);
  return result.output.trim();
}
