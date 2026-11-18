import { ORG_ROLE_POLICIES, type OrgPolicy, type OrgRole, requireStaff } from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { type AccountsDeps, isUuid } from "./deps";
import { type DocumentRow, type OrgRow, type RoomPersonRow, store } from "./storage";

/**
 * Every access decision of the accounts routes, in one place, on top of @dembrane/access:
 * org roles for the customer side (Access.org with an account policy), the named staff
 * permission for the admin side, one narrow grant for a person named to sign a single
 * document without being a member, and the data room: a member brought in reads the offer
 * and the DPA. Room access counts only while they hold an active membership.
 */

/** The roles whose holders run an account, straight from the access policies. */
export const ACCOUNT_ROLES = (Object.keys(ORG_ROLE_POLICIES) as OrgRole[]).filter((r) =>
  ORG_ROLE_POLICIES[r].has("account:read"),
);
export const runsAccount = (role: string | null | undefined): boolean =>
  (ACCOUNT_ROLES as readonly string[]).includes(role ?? "");

/** The live organisation, when the caller's org role holds the policy. */
export async function customerOrg(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  policy: OrgPolicy,
): Promise<OrgRow> {
  if (!isUuid(orgId)) throw new NotFoundError("organisation.not_found");
  await d.access.org(who, orgId, policy);
  const org = await store.org(d.db, orgId);
  if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
  return org;
}

/** The caller's verified address, or null. */
async function verifiedEmail(d: AccountsDeps, who: Signed): Promise<string | null> {
  const identity = await store.identity(d.db, who.directusUserId);
  return identity?.verified ? identity.email.toLowerCase() : null;
}

/**
 * The caller's room row: by their app user, or by their verified address while the row has
 * none (an invitation taken up from the dashboard's own invitation list). Pass the
 * address when it is known already.
 */
async function roomRowOf(d: AccountsDeps, who: Signed, orgId: string, email?: string | null) {
  if (!who.appUserId) return null;
  const address = email === undefined ? await verifiedEmail(d, who) : email;
  return store.roomPersonOf(d.db, orgId, who.appUserId, address);
}

/** The caller's room row when it grants access; whether they are a member is the caller's check. */
async function roomRow(d: AccountsDeps, who: Signed, orgId: string, email?: string | null) {
  const row = await roomRowOf(d, who, orgId, email);
  return row?.accessGrantedAt ? row : null;
}

export interface RoomAccess {
  readonly org: OrgRow;
  /** `account`: runs the account (owner, admin, Billing); `room`: a member brought in. */
  readonly via: "account" | "room";
  /** The room row that grants access, when `room`; null when `account` (see myRoomRow). */
  readonly row: RoomPersonRow | null;
}

/** The caller's own room row: their access, or the labels someone set for them. */
export const myRoomRow = (d: AccountsDeps, who: Signed, access: RoomAccess) =>
  access.row ? Promise.resolve(access.row) : roomRowOf(d, who, access.org.id);

/**
 * `account:room`: whoever runs the account, or a member with room access. A plain member
 * without it is refused (403) and anyone else does not find the organisation (404).
 */
export async function roomOrg(d: AccountsDeps, who: Signed, orgId: string): Promise<RoomAccess> {
  try {
    return { org: await customerOrg(d, who, orgId, "account:read"), via: "account", row: null };
  } catch (err) {
    // Access.org refuses a member with 403 only after finding their active membership.
    if (!(err instanceof ForbiddenError)) throw err;
    const row = await roomRow(d, who, orgId);
    const org = row ? await store.org(d.db, orgId) : null;
    if (!row || !org || org.deleted_at) throw err;
    return { org, via: "room", row };
  }
}

/** What a room member reads of the account: the offer and the DPA, never a draft. */
export const inRoom = (doc: Pick<DocumentRow, "kind" | "status">): boolean =>
  (doc.kind === "offer" || doc.kind === "dpa") && doc.status !== "draft";

export interface DocumentAccess {
  readonly org: OrgRow;
  readonly doc: DocumentRow;
  /**
   * `member`: through the org role; `signer`: named on this one document; `room`: a member
   * with room access, reading the offer or the DPA.
   */
  readonly via: "member" | "signer" | "room";
  /** The caller's verified address. */
  readonly email: string | null;
}

const SIGNER_POLICIES: readonly OrgPolicy[] = ["account:read", "account:sign"];

/**
 * A document through the org role, or, for someone named as its signer, that one document
 * while it waits for them (and after, to fetch the signed PDF), or, for a member with room
 * access, the offer and the DPA to read. Nothing else of the organisation is reachable the
 * last two ways. Tried in that order, so a room member who is named signs as the signer.
 * Drafts are never shown to the customer.
 */
export async function documentFor(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  policy: "account:read" | "account:sign",
): Promise<DocumentAccess> {
  if (!isUuid(orgId) || !isUuid(docId)) throw new NotFoundError("document.not_found");
  const email = await verifiedEmail(d, who);
  let org: OrgRow | null = null;
  let refused: Error | null = null;
  try {
    org = await customerOrg(d, who, orgId, policy);
  } catch (err) {
    // A plain member (403) or an outsider (404) may still be the named signer.
    if (!(err instanceof NotFoundError) && !(err instanceof ForbiddenError)) throw err;
    refused = err;
  }
  const doc = await store.document(d.db, orgId, docId);
  if (org) {
    if (!doc || doc.status === "draft") throw new NotFoundError("document.not_found");
    return { org, doc, via: "member", email };
  }
  const named =
    doc !== null &&
    email !== null &&
    doc.signerEmail?.toLowerCase() === email &&
    SIGNER_POLICIES.includes(policy) &&
    ["sent", "viewed", "signed"].includes(doc.status);
  if (!named || !doc) {
    if (refused instanceof ForbiddenError) {
      // Reading only: a room member never signs, declines or names a signer.
      const room =
        policy === "account:read" && doc && inRoom(doc)
          ? await roomRow(d, who, orgId, email)
          : null;
      const orgRow = room ? await store.org(d.db, orgId) : null;
      if (orgRow && !orgRow.deleted_at && doc) return { org: orgRow, doc, via: "room", email };
      throw refused;
    }
    throw new NotFoundError("document.not_found");
  }
  const orgRow = await store.org(d.db, orgId);
  if (!orgRow || orgRow.deleted_at) throw new NotFoundError("document.not_found");
  return { org: orgRow, doc, via: "signer", email };
}

/** Only the named signer signs once one is named; otherwise any member with account:sign. */
export function assertMaySign(a: DocumentAccess): void {
  if (a.doc.signerEmail && a.doc.signerEmail.toLowerCase() !== a.email)
    throw new ForbiddenError("document.signer_only", {
      params: { signer_email: a.doc.signerEmail },
    });
}

/** Staff permission check with its audit row, before anything else happens. */
export async function staffCan(
  d: AccountsDeps,
  who: Signed,
  action: string,
  target?: { type: string; id: string },
  requestId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await requireStaff(d.staffAudit, who, {
    permission: "staff:accounts",
    action,
    ...(target && { targetType: target.type, targetId: target.id }),
    ...(detail && { detail }),
    ...(requestId && { requestId }),
  });
}

/**
 * An email to a customer leaves on a person's own action. A staff API key (sam's) prepares
 * and reads; where a staff call would queue an email (an offer sent with `notify`, a
 * message, a demo's sign-in invitation) it is refused here, and a signed-in staff member
 * sends from the staff pages. Every staff route that can email calls this before it writes
 * anything.
 */
export function assertPersonSends(who: Signed): void {
  // Only a staff API key carries its own list of staff permissions (apps/api session).
  if (who.staffPolicies) throw new ForbiddenError("staff.key_cannot_email");
}

/** An organisation staff may manage: any live one. */
export async function staffOrg(d: AccountsDeps, orgId: string): Promise<OrgRow> {
  const org = isUuid(orgId) ? await store.org(d.db, orgId) : null;
  if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
  return org;
}
