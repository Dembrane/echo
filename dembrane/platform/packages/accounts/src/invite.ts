import { createHmac, timingSafeEqual } from "node:crypto";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type AccountsDeps, isUuid } from "./deps";
import { accountPageUrl } from "./jobs";
import { type DocumentRow, store } from "./storage";

/**
 * The link in a signer invitation. It carries a token bound to the document, the address
 * named and the moment they were named, so the page it opens can greet that person before
 * they sign in: who asked, for which document, with their name and address filled in. Naming
 * someone else, or the same person again, makes a new token and the old link stops working.
 * The token only shows the invitation; signing still needs the code sent to that address.
 */
export function signerInviteToken(secret: string, doc: DocumentRow): string | null {
  if (!doc.signerEmail || !doc.signerInvitedAt) return null;
  return createHmac("sha256", secret)
    .update(
      `signer-invite:${doc.id}:${doc.signerEmail.toLowerCase()}:${doc.signerInvitedAt.toISOString()}`,
    )
    .digest("base64url")
    .slice(0, 32);
}

export function signerInviteUrl(dashboardUrl: string, secret: string, doc: DocumentRow): string {
  const token = signerInviteToken(secret, doc);
  const page = `${accountPageUrl(dashboardUrl, doc.orgId)}/documents/${doc.id}/sign`;
  return token ? `${page}?invite=${token}` : page;
}

const sameToken = (a: string, b: string) => {
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
  const existing = await store.identityByEmail(d.db, email);
  const appUser = existing ? await store.appUserByDirectusId(d.db, existing.id) : null;
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
  if (!(await store.appUserByDirectusId(d.db, who.directusUserId))) {
    const first = body.first_name.trim();
    const last = body.last_name?.trim() || null;
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
  return { org_id: doc.orgId, document_id: doc.id };
}
