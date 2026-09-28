import { describe, expect, it } from 'vitest';
import {
  checkDeletionRequest,
  DELETION_REASON_MAX_LENGTH,
  DELETION_REQUESTER_MAX_LENGTH,
  InvalidDeletionRequestError,
} from './deletion.js';

describe('checkDeletionRequest (001 T053)', () => {
  it('accepts a requester and a reason at their bounds', () => {
    expect(() =>
      checkDeletionRequest(
        'x'.repeat(DELETION_REQUESTER_MAX_LENGTH),
        'y'.repeat(DELETION_REASON_MAX_LENGTH),
      ),
    ).not.toThrow();
  });

  it.each([
    ['empty requester', '', 'why'],
    ['blank requester', '   ', 'why'],
    ['over-long requester', 'x'.repeat(DELETION_REQUESTER_MAX_LENGTH + 1), 'why'],
    ['NUL in requester', 'pav\u0000lo', 'why'],
    ['empty reason', 'pavlo', ''],
    ['blank reason', 'pavlo', ' \n '],
    ['over-long reason', 'pavlo', 'y'.repeat(DELETION_REASON_MAX_LENGTH + 1)],
    ['NUL in reason', 'pavlo', 'a\u0000b'],
  ])('refuses %s', (_name, requestedBy, reason) => {
    expect(() => checkDeletionRequest(requestedBy, reason)).toThrow(InvalidDeletionRequestError);
  });
});
