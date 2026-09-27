import { describe, expect, it } from 'vitest';
import { describeViolations } from './expired-evidence.mjs';

describe('describeViolations (001 T035)', () => {
  it('names each violation, tenant and expiry', () => {
    const violations = [
      { id: 'ev-1', tenant_id: 'tenant-1', expires_at: new Date('2026-01-01T00:00:00Z') },
    ];
    expect(describeViolations(violations)).toBe(
      '1 evidence row(s) past expires_at are still linked: ' +
        'ev-1 (tenant tenant-1, expired 2026-01-01T00:00:00.000Z)',
    );
  });

  it('truncates the sample to 10 and says so, without hiding the real count', () => {
    const violations = Array.from({ length: 12 }, (_, i) => ({
      id: `ev-${i}`,
      tenant_id: 'tenant-1',
      expires_at: new Date('2026-01-01T00:00:00Z'),
    }));
    const message = describeViolations(violations);
    expect(message.startsWith('12 evidence row(s)')).toBe(true);
    expect(message.endsWith(', ...')).toBe(true);
  });
});
