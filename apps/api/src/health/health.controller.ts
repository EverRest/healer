import { Controller, Get, HttpCode } from '@nestjs/common';
import { type HealthReport, buildHealthReport } from './health.js';

/**
 * Thin by rule (`.claude/rules/backend-nestjs.md`): the controller shapes a response and
 * nothing more. Dependency probing arrives with the repositories in 001; until then the
 * report is honest about what it has checked.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly meta: {
      readonly service: string;
      readonly version: string;
      readonly build: string;
      readonly runnerProtocolVersion: number;
    },
  ) {}

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
