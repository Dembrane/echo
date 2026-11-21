import { createHmac, timingSafeEqual } from "node:crypto";
import { ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type AccountsDeps, type Conn, isUuid } from "./deps";
import { accountPageUrl } from "./jobs";
import { ensureUser } from "./prospect";
import { type DocumentRow, type RoomPersonRow, store } from "./storage";

/**
 * An invitation link's token: an HMAC of what the link is bound to, so it changes when
 * any of that does. Every link token is made here; the input is the caller's, and must
 * stay byte for byte what it was, or links already in mailboxes stop working.
 */
function linkToken(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url").slice(0, 32);
}

/**
 * The link in a signer invitation. It carries a token bound to the document, the address
 * named and the moment they were named, so the page it opens can greet that person before
 * they sign in: who asked, for which document, with their name and address filled in. Naming
 * someone else, or the same person again, makes a new token and the old link stops working.
 * The token only shows the invitation; signing still needs the code sent to that address.
 */
export function signerInviteToken(secret: string, doc: DocumentRow): string | null {
  if (!doc.signerEmail || !doc.signerInvitedAt) return null;
  return linkToken(
    secret,
    `signer-invite:${doc.id}:${doc.signerEmail.toLowerCase()}:${doc.signerInvitedAt.toISOString()}`,
  );
}

/**
 * The link in a room invitation: bound to the room's row, the address and the moment
 * access was granted. Taking the person out deletes the row, so the link stops.
 */
export function roomInviteToken(secret: string, row: RoomPersonRow): string | null {
  if (!row.accessGrantedAt) return null;
  return linkToken(
    secret,
    `room-invite:${row.id}:${row.email}:${row.accessGrantedAt.toISOString()}`,
  );
}

export function signerInviteUrl(dashboardUrl: string, secret: string, doc: DocumentRow): string {
  const token = signerInviteToken(secret, doc);
  const page = `${accountPageUrl(dashboardUrl, doc.orgId)}/documents/${doc.id}/sign`;
  return token ? `${page}?invite=${token}` : page;
}

export const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The document a valid token names; anything else reads as not found, as a wrong id does. */
async function invitedDocument(d: AccountsDeps, orgId: string, docId: string, token: string) {
  if (!isUuid(orgId) || !isUuid(docId)) throw new NotFoundError("document.not_found");
  const doc = await store.document(d.db, orgId, docId);
  const expected = doc ? signerInviteToken(d.settings.inviteSecret, doc) : null;
  if (!doc || !expected || doc.status === "draft" || !sameToken(expected, token))
    throw new NotFoundError("document.not_found");
  const org = await store.org(d.db, orgId);
  if (!org || org.deleted_at) throw new NotFoundError("document.not_found");
  return { doc, org };
}

/** "Jor Theuns" → first "Jor", last "Theuns"; one word is a first name only. */
export function splitName(name: string | null): { first_name: string; last_name: string } {
  const [first = "", ...rest] = (name ?? "").trim().split(/\s+/);
  return { first_name: first, last_name: rest.join(" ") };
}

/**
 * What the invitation page shows before anyone signs in. `has_account`: the address already
 * has a dembrane account, so the page asks for nothing but the code and leaves its name be.
 */
export async function signerInvite(d: AccountsDeps, orgId: string, docId: string, token: string) {
  const { doc, org } = await invitedDocument(d, orgId, docId, token);
  const email = (doc.signerEmail as string).toLowerCase();
  const [named] = await d.db
    .select({ actor: schema.account_event.actorUserId })
    .from(schema.account_event)
    .where(
      and(
        eq(schema.account_event.orgId, org.id),
        eq(schema.account_event.subjectId, doc.id),
        inArray(schema.account_event.type, ["document.signer_named", "document.signer_replaced"]),
      ),
    )
    .orderBy(desc(schema.account_event.createdAt))
    .limit(1);
  const inviter = named?.actor ? await store.identity(d.db, named.actor) : null;
  const appUser = await store.appUserByEmail(d.db, email);
  return {
    organisation: { name: org.name },
    inviter: inviter ? { name: inviter.name || inviter.email } : null,
    document: { title: doc.title, kind: doc.kind, reference: doc.reference },
    signer: { email, ...splitName(doc.signerName), role: doc.signerRole },
    status:
      doc.status === "signed"
        ? ("signed" as const)
        : ["sent", "viewed"].includes(doc.status)
          ? ("open" as const)
          : ("closed" as const),
    has_account: appUser !== null,
  };
}

/**
 * After the code sign-in: the invited person is who the link was for. Someone new keeps the
 * name they confirmed on the invitation page; an existing account keeps its own. Returns
 * where to go, so a page that holds a stale link does not guess.
 */
export async function acceptSignerInvite(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  body: { invite: string; first_name: string; last_name: string | null },
) {
  const { doc } = await invitedDocument(d, orgId, docId, body.invite);
  const me = await store.identity(d.db, who.directusUserId);
  const email = (doc.signerEmail as string).toLowerCase();
  if (!me?.verified || me.email.toLowerCase() !== email)
    throw new ForbiddenError("document.signer_only", { params: { signer_email: email } });
  await nameNewcomer(d, who, body);
  return { org_id: doc.orgId, document_id: doc.id };
}

/**
 * Someone new, just past the code sign-in, keeps the name they confirmed on an invitation
 * page; an existing account (one with an app user) keeps its own.
 */
export async function nameNewcomer(
  d: AccountsDeps,
  who: Signed,
  name: { first_name: string; last_name: string | null },
): Promise<void> {
  if (await store.appUserByDirectusId(d.db, who.directusUserId)) return;
  const first = name.first_name.trim();
  const last = name.last_name?.trim() || null;
  await d.db.transaction(async (tx) => {
    await tx
      .update(schema.directus_users)
      .set({ first_name: first, last_name: last })
      .where(eq(schema.directus_users.id, who.directusUserId));
    await tx
      .update(schema.auth_user)
      .set({ name: [first, last].filter(Boolean).join(" "), updatedAt: d.now() })
      .where(eq(schema.auth_user.id, who.directusUserId));
  });
}

/**
 * Takes up the pending invitation to the organisation for this person, in the caller's
 * transaction, with the app user a code sign-in does not make: on signing (the invitation
 * naming them made, role billing) and on accepting a room invitation (role member). Seats
 * are not billed per person, so nothing else changes. Without such an invitation (it was
 * revoked, or they were already a member) nothing happens and null is returned; else
 * their app user id.
 */
export async function joinByInvite(
  tx: Conn,
  orgId: string,
  person: { directusUserId: string; email: string },
  now: Date,
): Promise<string | null> {
  const email = person.email.toLowerCase();
  const nowIso = now.toISOString();
  const invite = await store.pendingOrgInvite(tx, orgId, email, now);
  if (!invite) return null;
  const identity = await store.identity(tx, person.directusUserId);
  const { appUserId } = await ensureUser(tx, {
    email,
    name: identity?.name || null,
    passwordHash: null,
    nowIso,
  });
  const membership = await store.orgMembership(tx, orgId, appUserId);
  const role = invite.role || "billing";
  if (!membership)
    await tx.insert(schema.org_membership).values({
      id: newId(),
      org_id: orgId,
      user_id: appUserId,
      role,
      created_at: nowIso,
      updated_at: nowIso,
    });
  else if (membership.deleted_at)
    await tx
      .update(schema.org_membership)
      .set({ deleted_at: null, role, updated_at: nowIso })
      .where(eq(schema.org_membership.id, membership.id));
  await tx
    .update(schema.org_invite)
    .set({ accepted_at: nowIso })
    .where(eq(schema.org_invite.id, invite.id));
  return appUserId;
}
