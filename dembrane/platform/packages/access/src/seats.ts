/** dembrane's own addresses, as the staff routes check an account manager or a new staff member. */
const STAFF_DOMAIN = "@dembrane.com";

/**
 * A commercial rule, not an access rule, and one that can be dropped: someone with a
 * @dembrane.com address who holds a row in a workspace of an organisation they are not a
 * member of takes no seat on that organisation's account. That is the staff member who made
 * a demo, in a new prospect's "dembrane demo", and any dembrane person a customer adds to one
 * workspace for help. A dembrane person who is a member of the organisation itself counts
 * like anyone. The address is read as the staff routes read it: trimmed, in any case.
 *
 * Every seat read asks this, so they agree: billing's (BillingService.workspaceSeatUserIds,
 * which counting, the seat emails and reconcile use), the invite dialog's preview in
 * @dembrane/account, and the staff billing rollup. Access, lists and counts do not read it.
 */
export function staffGuestTakesNoSeat(
  email: string | null | undefined,
  inOrganisation: boolean,
): boolean {
  return !inOrganisation && (email ?? "").trim().toLowerCase().endsWith(STAFF_DOMAIN);
}
