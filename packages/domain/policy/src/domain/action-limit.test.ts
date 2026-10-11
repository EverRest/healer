import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_LIMIT_MINIMA,
  actionLimitLockKey,
  cooldownGroupOf,
  DEFAULT_REMEDIATION_ACTION_LIMIT,
  type ActionLimitRead,
} from './action-limit.js';

const root = (path: string) => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url));
const sql = readFileSync(
  root('prisma/migrations/20261009000000_action_limit/migration.sql'),
  'utf8',
);

const none: ActionLimitRead = {
  configured: null,
  windowSeconds: 3600,
  recentAllowCount: 2,
  attemptCount: 5,
  secondsSinceLastAllow: 40,
};

describe('action limit (T054, FR-014)', () => {
  it('the minima in the migration equal the constants in code', () => {
    const literal = (column: string) =>
      Number(sql.match(new RegExp(`"${column}" >= (\\d+)`))?.[1] ?? Number.NaN);
    expect(literal('rate_per_window')).toBe(ACTION_LIMIT_MINIMA.ratePerWindow);
    expect(literal('window_seconds')).toBe(ACTION_LIMIT_MINIMA.windowSeconds);
    expect(literal('cooldown_seconds')).toBe(ACTION_LIMIT_MINIMA.cooldownSeconds);
    expect(literal('attempt_cap')).toBe(ACTION_LIMIT_MINIMA.attemptCap);
  });

  it('the default bounds satisfy the minima the table enforces', () => {
    for (const key of Object.keys(ACTION_LIMIT_MINIMA) as (keyof typeof ACTION_LIMIT_MINIMA)[]) {
      expect(DEFAULT_REMEDIATION_ACTION_LIMIT[key]).toBeGreaterThanOrEqual(
        ACTION_LIMIT_MINIMA[key],
      );
    }
  });

  it('a reversible_remediation action with no row runs under the default bounds', () => {
    const { windowSeconds: _w, ...bounds } = DEFAULT_REMEDIATION_ACTION_LIMIT;
    expect(cooldownGroupOf(none, 'reversible_remediation')).toEqual({
      recentAllowCount: 2,
      windowSeconds: 3600,
      attemptCount: 5,
      secondsSinceLastAllow: 40,
      bounds,
    });
  });

  it('any other class with no row has no bounds, but the counts are still filled', () => {
    const group = cooldownGroupOf(none, 'code_change');
    expect(group.bounds).toBeUndefined();
    expect(group.attemptCount).toBe(5);
  });

  it('a configured row wins over the default, for any class', () => {
    const configured = { ratePerWindow: 9, cooldownSeconds: 0, attemptCap: 9 };
    expect(cooldownGroupOf({ ...none, configured }, 'reversible_remediation').bounds).toEqual(
      configured,
    );
    expect(cooldownGroupOf({ ...none, configured }, 'code_change').bounds).toEqual(configured);
  });

  it('no counted allow leaves secondsSinceLastAllow absent', () => {
    const group = cooldownGroupOf({ ...none, secondsSinceLastAllow: null }, 'code_change');
    expect('secondsSinceLastAllow' in group).toBe(false);
  });

  it('the lock key names the whole scope, with null as empty', () => {
    expect(actionLimitLockKey('t', 'a', 'r', 'f')).toBe('policy.action_limit:t:a:r:f');
    expect(actionLimitLockKey('t', 'a', null, undefined)).toBe('policy.action_limit:t:a::');
  });
});

// T085: `policy.action_limit` is the one store of rate, cooldown and attempt-cap bounds (C-11). 010
// keeps no `remediation_limit`; a second table carrying those columns would be a second authority.
describe('action_limit is the single limit store (T085, C-11)', () => {
  const schema = readFileSync(root('prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1]!,
    body: m[2]!,
  }));

  it('only ActionLimit carries the limit columns', () => {
    const carriers = models
      .filter((m) => /@map\("(rate_per_window|cooldown_seconds|attempt_cap)"\)/.test(m.body))
      .map((m) => m.name);
    expect(carriers).toEqual(['ActionLimit']);
  });

  it('no model creates a remediation_limit', () => {
    expect(models.map((m) => m.name.toLowerCase())).not.toContain('remediationlimit');
    expect(schema).not.toMatch(/remediation_limit/);
  });
});
