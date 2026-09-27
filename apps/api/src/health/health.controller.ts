import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { type HealthReport, buildHealthReport } from './health.js';

export interface HealthMeta {
  readonly service: string;
  readonly version: string;
  readonly build: string;
  readonly runnerProtocolVersion: number;
}

/**
 * The DI token for `HealthMeta`. A plain object-typed constructor parameter reflects to
 * `Object` at runtime (TypeScript erases inline object types for `design:paramtypes`), which
 * Nest cannot resolve to any provider — an explicit token is required, not optional style.
 */
export const HEALTH_META = Symbol('HEALTH_META');

/**
 * Thin by rule (`.claude/rules/backend-nestjs.md`): the controller shapes a response and
 * nothing more. Dependency probing arrives with the repositories in 001; until then the
 * report is honest about what it has checked.
 */
@Controller()
export class HealthController {
  constructor(@Inject(HEALTH_META) private readonly meta: HealthMeta) {}

  @Get('health')
  @HttpCode(200)
  health(): Pick<HealthReport, 'status' | 'service' | 'version' | 'build'> {
    const { status, service, version, build } = buildHealthReport({
      ...this.meta,
      dependencies: [],
    });
    return { status, service, version, build };
  }

  @Get('ready')
  ready(): HealthReport {
    return buildHealthReport({ ...this.meta, dependencies: [] });
  }
}
