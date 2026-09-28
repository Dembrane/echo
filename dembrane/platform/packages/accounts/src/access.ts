import { type OrgPolicy, requireStaff } from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { type AccountsDeps, isUuid } from "./deps";
import { type DocumentRow, type OrgRow, store } from "./storage";

/**
 * Every access decision of the accounts routes, in one place, on top of @dembrane/access:
 * org roles for the customer side (Access.org with an account policy), the named staff
 * permission for the admin side, and one narrow grant for a person named to sign a single
 * document without being a member.
 */

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

export interface DocumentAccess {
  readonly org: OrgRow;
  readonly doc: DocumentRow;
  /** `member`: through the org role; `signer`: named on this one document. */
  readonly via: "member" | "signer";
  /** The caller's verified address. */
  readonly email: string | null;
}

const SIGNER_POLICIES: readonly OrgPolicy[] = ["account:read", "account:sign"];

/**
 * A document through the org role, or, for someone named as its signer, that one document
 * while it waits for them (and after, to fetch the signed PDF). Nothing else of the
 * organisation is reachable that way. Drafts are never shown to the customer.
 */
export async function documentFor(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  policy: "account:read" | "account:sign",
): Promise<DocumentAccess> {
  if (!isUuid(orgId) || !isUuid(docId)) throw new NotFoundError("document.not_found");
  const identity = await store.identity(d.db, who.directusUserId);
  const email = identity?.verified ? identity.email.toLowerCase() : null;
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
    if (refused instanceof ForbiddenError) throw refused;
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

/** An organisation staff may manage: any live one. */
export async function staffOrg(d: AccountsDeps, orgId: string): Promise<OrgRow> {
  const org = isUuid(orgId) ? await store.org(d.db, orgId) : null;
  if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
  return org;
}
