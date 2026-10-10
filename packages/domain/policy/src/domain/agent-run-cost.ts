import { HealerError } from '@healer/shared';

const COLUMN_SCALE = 6;
const COLUMN_MAX = 999_999.999999; // numeric(12,6)

/**
 * A reported cost, as the `agent_run.cost` numeric(12,6) literal. A cost beyond six decimals is
 * **rounded**, not refused: a runner cannot know the column's scale, and refusing would drop a real
 * charge from the budget (a spend nobody sees is worse than one off by under half a micro-unit).
 * `toFixed` formats the binary double's own value, so a `0.1 + 0.2` arrives as `0.300000` and never
 * reaches the database as a float. Negative, non-finite and over-range values are refused — a
 * measurement is none of those.
 */
export function toCostDecimal(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new HealerError('VALIDATION', 'a reported cost must be a finite, non-negative number');
  }
  const decimal = cost.toFixed(COLUMN_SCALE);
  if (Number(decimal) > COLUMN_MAX) {
    throw new HealerError('VALIDATION', 'a reported cost exceeds what agent_run.cost can hold');
  }
  return decimal;
}
