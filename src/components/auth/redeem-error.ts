/**
 * Maps the refusals of POST /api/invitations/[token]/redeem onto message
 * keys the join page can translate.
 *
 * The route forwards the `redeem_invitation` RPC's own error text
 * (migration 019) for 400 / 401 / 409, and that text is English and
 * written for a developer ("Your account already contains data; sign up
 * with a different email to join this one"). Showing it verbatim put an
 * English sentence in the middle of a Spanish screen. The messages are
 * fixed strings in the migration, so matching them is reliable; anything
 * unrecognised returns `null` and the page falls back to whatever the
 * server sent (the route's own failures are already translated).
 *
 * Pure, so it is unit-tested.
 */
export type RedeemErrorKey =
  | 'alreadyMember'
  | 'sharedAccount'
  | 'hasData'
  | 'notFound'
  | 'used'
  | 'expired'
  | 'unauthorized';

export function redeemErrorKey(
  status: number,
  message: string | null | undefined,
): RedeemErrorKey | null {
  const text = (message ?? '').toLowerCase();

  if (status === 409) {
    if (text.includes('already a member')) return 'alreadyMember';
    if (text.includes('already in a shared account')) return 'sharedAccount';
    if (text.includes('already contains data')) return 'hasData';
    return null;
  }

  if (status === 400) {
    if (text.includes('not found')) return 'notFound';
    if (text.includes('already been redeemed')) return 'used';
    if (text.includes('expired')) return 'expired';
    return null;
  }

  if (status === 401) {
    if (text === 'unauthorized' || text.includes('no profile')) return 'unauthorized';
    return null;
  }

  return null;
}
