import { describe, expect, it } from 'vitest';

import { redeemErrorKey } from './redeem-error';

describe('redeemErrorKey', () => {
  it.each([
    [409, 'You are already a member of this account', 'alreadyMember'],
    [
      409,
      'You are already in a shared account; sign up with a different email to join this one',
      'sharedAccount',
    ],
    [
      409,
      'Your account already contains data; sign up with a different email to join this one',
      'hasData',
    ],
    [400, 'Invitation not found', 'notFound'],
    [400, 'Invitation has already been redeemed', 'used'],
    [400, 'Invitation has expired', 'expired'],
    [401, 'Unauthorized', 'unauthorized'],
    [401, 'Caller has no profile', 'unauthorized'],
  ] as const)('%i "%s" -> %s', (status, message, expected) => {
    expect(redeemErrorKey(status, message)).toBe(expected);
  });

  it('returns null for text it does not know so the server wording is kept', () => {
    expect(redeemErrorKey(409, 'something new')).toBeNull();
    expect(redeemErrorKey(400, 'bad body')).toBeNull();
    expect(redeemErrorKey(401, 'No autorizado')).toBeNull();
    expect(redeemErrorKey(500, 'Invitation has expired')).toBeNull();
    expect(redeemErrorKey(409, undefined)).toBeNull();
  });
});
