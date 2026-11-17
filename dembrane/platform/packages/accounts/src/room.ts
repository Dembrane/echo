import { deriveWorkspaceRole, workspaceReach } from "@dembrane/access";
import { sendEmail, subjectOf } from "@dembrane/account";
import { hostDistinctId } from "@dembrane/analytics";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { localeOfEmail } from "@dembrane/i18n";
import { customerOrg, type RoomAccess, roomOrg, runsAccount, staffOrg } from "./access";
import {
  HintLabel,
  RoomLabel,
  type RoomLabelT,
  type RoomPageT,
  type RoomPersonT,
} from "./contract";
import { dpaOf } from "./customer";
import { type AccountsDeps, isUuid, type Tx } from "./deps";
import { emit } from "./events";
import { joinByInvite, nameNewcomer, roomInviteToken, sameToken, splitName } from "./invite";
import { accountPageUrl } from "./jobs";
import { orgLanguage } from "./recipients";
import {
  type DocumentRow,
  type OrgRow,
  type RoomPersonRow,
  type SignatureRow,
  store,
} from "./storage";

/**
 * The data room: the colleagues an organisation brings in to decide on an offer with it.
 * Who runs the account (owner, admin, Billing) is in by their role; a member brought in
 * reads the offer and the DPA (access.ts); someone new is invited as a plain member. Each
 * person carries labels saying what they do in the decision. Nobody takes a seat: seats
 * come from direct workspace rows, and the room makes none.
 */

/** Each addition may send an invitation, so ten an hour per organisation, as signer namings. */
const ROOM_LIMIT = { name: "account_room", capacity: 10, windowSeconds: 3600 };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** Labels in the order the contract lists them, each once. */
const inOrder = (labels: readonly string[]): RoomLabelT[] =>
  RoomLabel.options.filter((l) => labels.includes(l));
const hintsInOrder = (labels: readonly string[]) =>
  HintLabel.options.filter((l) => labels.includes(l));

type Member = Awaited<ReturnType<typeof store.members>>[number];
type RoomRow = Awaited<ReturnType<typeof store.roomPeople>>[number];

/** The active member a room row is about: by app user, or by address on a row without one. */
function memberOf(members: readonly Member[], row: RoomPersonRow): Member | null {
  return (
    members.find(
      (m) =>
        (row.appUserId && m.appUserId === row.appUserId) ||
        (!row.appUserId && m.email?.toLowerCase() === row.email),
    ) ?? null
  );
}

/**
 * Who changes what someone in the room does, or takes them out: those who run the account
 * (owners, admins, Billing), for anyone; a room member, only for the people they invited.
 */
const managesPerson = (access: RoomAccess, row: RoomPersonRow | null, who: Signed) =>
  access.via === "account" || (row?.invitedBy != null && row.invitedBy === who.appUserId);

/** PostHog, after the commit: under the person acting, never with anyone else's address. */
async function track(
  d: AccountsDeps,
  actor: { email: string | null | undefined; directusUserId: string },
  event: string,
  properties: Record<string, unknown>,
) {
  await d.capture?.(hostDistinctId(actor.email, actor.directusUserId), event, properties);
}

// ── who signs ───────────────────────────────────────────────────────────

type Signers = RoomPageT["signers"];

/** The named signer, else whoever signed for the customer, else nobody yet. */
function signerOf(doc: DocumentRow | null, sigs: readonly SignatureRow[]) {
  if (!doc) return null;
  if (doc.signerEmail)
    return { document_id: doc.id, email: doc.signerEmail.toLowerCase(), name: doc.signerName };
  const sig = sigs.find((s) => s.documentId === doc.id && s.slot === "customer");
  return sig ? { document_id: doc.id, email: sig.email.toLowerCase(), name: sig.typedName } : null;
}

/** The newest sent, viewed or signed offer and its DPA, as the signer model has them. */
function roomSigners(docs: readonly DocumentRow[], sigs: readonly SignatureRow[]): Signers {
  const live = ["sent", "viewed", "signed"];
  const offer = docs.find((x) => x.kind === "offer" && live.includes(x.status)) ?? null;
  return {
    offer: signerOf(offer, sigs),
    dpa: signerOf(offer ? dpaOf(docs, offer, live) : null, sigs),
  };
}

// ── the people ──────────────────────────────────────────────────────────

/**
 * Everyone the room knows, as those who run the account see them: every member (by role,
 * by invitation or not in the room) and everyone invited who has not accepted yet. A row
 * whose person left the organisation, or whose invitation lapsed, shows nobody.
 */
async function roomPeople(
  d: AccountsDeps,
  orgId: string,
  signers: Signers,
): Promise<RoomPersonT[]> {
  const now = d.now();
  const [members, rows, pending] = await Promise.all([
    store.members(d.db, orgId),
    store.roomPeople(d.db, orgId),
    store.pendingOrgInvites(d.db, orgId, now),
  ]);
  const view = (
    r: RoomRow | null,
    who: {
      appUserId: string | null;
      name: string;
      email: string;
      role: RoomPersonT["org_role"];
      room: RoomPersonT["room"];
    },
  ): RoomPersonT => ({
    id: r?.row.id ?? null,
    app_user_id: who.appUserId,
    name: who.name,
    email: who.email,
    org_role: who.role,
    room: who.room,
    status: who.role ? "member" : "invited",
    labels: inOrder(r?.row.labels ?? []),
    other: r?.row.other ?? null,
    labels_answered_at: iso(r?.row.labelsAnsweredAt),
    invited_by: r?.row.invitedBy
      ? { app_user_id: r.row.invitedBy, name: r.inviterName ?? "" }
      : null,
    invited_at: iso(r?.row.accessGrantedAt),
    signs: (["offer", "dpa"] as const).filter((k) => signers[k]?.email === who.email),
  });
  const people: RoomPersonT[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const email = (m.email ?? "").toLowerCase();
    const r = rows.find((x) => memberOf([m], x.row) !== null) ?? null;
    if (r) seen.add(r.row.id);
    const role = m.role as NonNullable<RoomPersonT["org_role"]>;
    const room = runsAccount(role) ? "by_role" : r?.row.accessGrantedAt ? "by_invite" : "none";
    people.push(view(r, { appUserId: m.appUserId, name: m.name || email, email, role, room }));
  }
  const waiting = new Set(pending.map((i) => i.email.toLowerCase()));
  for (const r of rows)
    if (!seen.has(r.row.id) && r.row.accessGrantedAt && waiting.has(r.row.email))
      people.push(
        view(r, {
          // Until they accept, nothing says whether the address has an account, or whose:
          // no app user and the name the inviter typed.
          appUserId: null,
          name: r.row.name,
          email: r.row.email,
          role: null,
          room: "by_invite",
        }),
      );
  return people;
}

/** Someone else brought them in and they have not said yet whether the labels are right. */
const asksLabels = (row: RoomPersonRow | null, appUserId: string | null) =>
  Boolean(row?.invitedBy && row.invitedBy !== appUserId && !row.labelsAnsweredAt);

async function roomPage(
  d: AccountsDeps,
  org: OrgRow,
  viewer: { who: Signed; access: RoomAccess } | null,
): Promise<RoomPageT> {
  const [docs, sigs, hints] = await Promise.all([
    store.documents(d.db, org.id),
    store.signatures(d.db, org.id),
    store.dismissedHints(d.db, org.id),
  ]);
  const signers = roomSigners(docs, sigs);
  const all = await roomPeople(d, org.id, signers);
  const room = viewer?.access.via === "room";
  return {
    // A room member sees the room's people; who runs the account sees every member, to bring them in.
    people: room ? all.filter((p) => p.room !== "none") : all,
    signers,
    dismissed_hints: hintsInOrder(hints),
    me: viewer
      ? {
          app_user_id: viewer.who.appUserId as string,
          room: room ? "by_invite" : "by_role",
          may_dismiss_hints: !room,
          labels_question: asksLabels(viewer.access.row, viewer.who.appUserId),
        }
      : null,
  };
}

export async function readRoom(d: AccountsDeps, who: Signed, orgId: string) {
  const access = await roomOrg(d, who, orgId);
  return roomPage(d, access.org, { who, access });
}

/** The staff side reads the room as an admin would, with no `me`. */
export async function staffRoom(d: AccountsDeps, orgId: string) {
  return roomPage(d, await staffOrg(d, orgId), null);
}

/** One person as the listing shows them, after a change. */
async function personOf(d: AccountsDeps, orgId: string, email: string): Promise<RoomPersonT> {
  const [docs, sigs] = await Promise.all([
    store.documents(d.db, orgId),
    store.signatures(d.db, orgId),
  ]);
  const person = (await roomPeople(d, orgId, roomSigners(docs, sigs))).find(
    (p) => p.email === email,
  );
  if (!person) throw new NotFoundError("room.person_not_found");
  return person;
}

// ── adding someone ──────────────────────────────────────────────────────

/**
 * Decided for risk 1 of the data room design: a workspace every member joins
 * (inherit_organisation_members) gives a new plain member its projects, conversations and
 * transcripts. So in an organisation with one, only those who run the account may bring
 * in someone who is not a member yet; a room member is refused. Returns how many
 * workspaces the new person reaches once they accept. The one place to relax the rule.
 * Counted for a new member whoever the address belongs to, so the answer never tells an
 * address with an account from one without.
 */
async function newcomerReach(d: AccountsDeps, access: RoomAccess): Promise<number> {
  const reached = (await store.orgWorkspaces(d.db, access.org.id)).filter(
    (ws) => deriveWorkspaceRole(workspaceReach(ws), "member", "") !== null,
  ).length;
  if (reached > 0 && access.via === "room")
    throw new ForbiddenError("room.new_person_admins_only", { params: { workspaces: reached } });
  return reached;
}

/** The invitation email: in their own language when they have an account, else the organisation's. */
async function emailInvite(
  d: AccountsDeps,
  tx: Tx,
  org: OrgRow,
  inviter: { name: string | null; email: string } | null,
  to: string,
  roomUrl: string,
) {
  const language =
    (await localeOfEmail(tx, to).catch(() => null)) ?? (await orgLanguage(tx, org.id));
  const data = {
    inviter_name: inviter?.name || inviter?.email || org.name,
    org_name: org.name,
    room_url: roomUrl,
  };
  await d.jobs.enqueue(
    sendEmail,
    {
      language,
      to,
      subject: subjectOf({ template: "account_room_invite", data }, language) ?? "",
      template: "account_room_invite",
      data,
      context: `account room invite ${org.id}`,
    },
    { tx },
  );
}

const roomJoinUrl = (dashboardUrl: string, orgId: string, token: string) =>
  `${accountPageUrl(dashboardUrl, orgId)}/join?invite=${token}`;

/**
 * Adds a person, or changes what someone already in the room does, in this order:
 * - an owner, admin or Billing member, or someone in the room already or invited and not
 *   yet accepted: labels only, nothing sent (`updated`), if the caller manages them
 *   (managesPerson), else 403;
 * - a member: room access and labels at once, an email linking the account (`added`);
 * - anyone else: a pending invitation as a plain member, 30 days, and an email with the
 *   link to their invitation page (`invited`).
 * The route refuses a staff key before it reads the body: it never emails a customer.
 */
export async function addRoomPerson(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: { email: string; name: string; labels: readonly RoomLabelT[]; other: string | null },
) {
  const access = await roomOrg(d, who, orgId);
  const { org } = access;
  const email = input.email.trim().toLowerCase();
  const me = await store.identity(d.db, who.directusUserId);
  if (me?.email.toLowerCase() === email) throw new BadRequestError("invite.self");
  await d.limiter.check(ROOM_LIMIT, org.id);
  const labels = inOrder(input.labels);
  const other = input.other;
  const now = d.now();
  const member = (await store.members(d.db, org.id)).find((m) => m.email?.toLowerCase() === email);
  const row = member
    ? await store.roomPersonOf(d.db, org.id, member.appUserId, email)
    : await store.roomPersonByEmail(d.db, org.id, email);
  const pending = member ? null : await store.pendingOrgInvite(d.db, org.id, email, now);
  const done = async (
    status: "invited" | "added" | "updated",
    sent: boolean,
    workspaces: number | null = null,
  ) => ({
    status,
    person: await personOf(d, org.id, email),
    email_sent: sent,
    workspaces_reached: workspaces,
  });

  const inByRole = member && runsAccount(member.role);
  const inRoomAlready = row?.accessGrantedAt && (member || pending);
  if (inByRole || inRoomAlready) {
    if (!managesPerson(access, row, who)) throw new ForbiddenError("room.manage_forbidden");
    if (row) await store.updateRoomPerson(d.db, row.id, { labels, other, updatedAt: now });
    else
      await store.insertRoomPerson(d.db, {
        id: newId(),
        orgId: org.id,
        email,
        appUserId: member?.appUserId ?? null,
        name: input.name,
        labels,
        other,
        invitedBy: who.appUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    return done("updated", false);
  }

  const appUser = member ? null : await store.appUserByEmail(d.db, email);
  const workspaces = member ? null : await newcomerReach(d, access);
  const id = row?.id ?? newId();
  const granted = {
    appUserId: member?.appUserId ?? appUser?.id ?? null,
    name: input.name,
    labels,
    other,
    accessGrantedAt: now,
    invitedBy: who.appUserId ?? null,
    labelsAnsweredAt: null,
    updatedAt: now,
  };
  await d.db.transaction(async (tx) => {
    // Someone with an invitation waiting (named to sign, say) keeps that one: one per address.
    const made = member
      ? null
      : await store.inviteToOrg(tx, {
          id: newId(),
          orgId: org.id,
          email,
          role: "member",
          invitedBy: who.appUserId ?? null,
          now,
        });
    const fields = { ...granted, orgInviteId: made };
    if (row) await store.updateRoomPerson(tx, id, fields);
    else await store.insertRoomPerson(tx, { id, orgId: org.id, email, createdAt: now, ...fields });
    const fresh = (await store.roomPerson(tx, org.id, id)) as RoomPersonRow;
    const token = roomInviteToken(d.settings.inviteSecret, fresh) as string;
    await emailInvite(
      d,
      tx,
      org,
      me,
      email,
      member
        ? accountPageUrl(d.settings.dashboardUrl, org.id)
        : roomJoinUrl(d.settings.dashboardUrl, org.id, token),
    );
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: member ? "room.person_added" : "room.person_invited",
      subject: { type: "room_person", id },
      detail: { labels, has_other: other !== null },
    });
  });
  await track(
    d,
    { email: me?.email, directusUserId: who.directusUserId },
    "server_room_person_invited",
    {
      org_id: org.id,
      person_id: id,
      labels,
      has_other: other !== null,
      existing_member: Boolean(member),
    },
  );
  return done(member ? "added" : "invited", true, workspaces);
}

// ── taking someone out ──────────────────────────────────────────────────

/**
 * Before they accepted: the row goes and the invitation it made is withdrawn, so the link
 * and the code sign-in stop; someone meanwhile named to sign gets the Billing invitation
 * naming would have made. After: room access and labels go and the membership stays. Once
 * accepted it is an ordinary membership that may carry workspaces and projects, and ending
 * memberships is for organisation admins; a room member removes only the people they
 * invited, so removal reaches no further than the room.
 */
export async function removeRoomPerson(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  personId: string,
) {
  const access = await roomOrg(d, who, orgId);
  const { org } = access;
  const row = isUuid(personId) ? await store.roomPerson(d.db, org.id, personId) : null;
  if (!row) throw new NotFoundError("room.person_not_found");
  const members = await store.members(d.db, org.id);
  const member = memberOf(members, row);
  if (member && runsAccount(member.role)) throw new ConflictError("room.in_by_role");
  if (!row.accessGrantedAt) throw new NotFoundError("room.person_not_found");
  if (!managesPerson(access, row, who)) throw new ForbiddenError("room.remove_forbidden");
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.deleteRoomPerson(tx, row.id);
    if (!member) {
      if (row.orgInviteId) await store.withdrawOrgInvite(tx, row.orgInviteId, now);
      if ((await store.waitingForSigner(tx, row.email)).some((x) => x.orgId === org.id))
        await store.inviteSigner(tx, {
          id: newId(),
          orgId: org.id,
          email: row.email,
          invitedBy: who.appUserId ?? null,
          now,
        });
    }
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "room.person_removed",
      subject: { type: "room_person", id: row.id },
      detail: { accepted: Boolean(member) },
    });
  });
  const me = await store.identity(d.db, who.directusUserId);
  const myRole = members.find((m) => m.appUserId === who.appUserId)?.role;
  await track(
    d,
    { email: me?.email, directusUserId: who.directusUserId },
    "server_room_person_removed",
    {
      org_id: org.id,
      person_id: row.id,
      by: access.via === "account" ? myRole : "inviter",
      accepted: Boolean(member),
    },
  );
  return {
    status: "removed" as const,
    membership: member ? ("kept" as const) : ("withdrawn" as const),
  };
}

// ── their own labels ────────────────────────────────────────────────────

/**
 * The person's own answer to "is this what you do?", asked once of someone brought in by
 * someone else. Confirming the labels as they are is an answer and no correction.
 */
export async function answerRoomLabels(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  input: { labels: readonly RoomLabelT[]; other: string | null },
) {
  const { org, row } = await roomOrg(d, who, orgId);
  if (!row || !asksLabels(row, who.appUserId)) {
    if (row?.labelsAnsweredAt) throw new ConflictError("room.labels_already_answered");
    throw new ConflictError("room.no_labels_question");
  }
  const labels = inOrder(input.labels);
  const before = inOrder(row.labels);
  const added = labels.filter((l) => !before.includes(l));
  const removed = before.filter((l) => !labels.includes(l));
  const otherChanged = (row.other ?? null) !== input.other;
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await store.updateRoomPerson(tx, row.id, {
      labels,
      other: input.other,
      labelsAnsweredAt: now,
      updatedAt: now,
    });
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "room.labels_answered",
      subject: { type: "room_person", id: row.id },
      detail: { labels, added, removed, other_changed: otherChanged },
    });
  });
  if (added.length || removed.length || otherChanged) {
    const me = await store.identity(d.db, who.directusUserId);
    await track(
      d,
      { email: me?.email, directusUserId: who.directusUserId },
      "server_room_labels_corrected",
      {
        org_id: org.id,
        person_id: row.id,
        labels,
        added,
        removed,
        other_changed: otherChanged,
      },
    );
  }
  return personOf(d, org.id, row.email);
}

// ── hints ───────────────────────────────────────────────────────────────

/** Waves away the hint about a label nobody holds, for the organisation. Twice is once. */
export async function dismissRoomHint(d: AccountsDeps, who: Signed, orgId: string, label: string) {
  const org = await customerOrg(d, who, orgId, "account:read");
  await d.db.transaction(async (tx) => {
    const made = await store.dismissHint(tx, {
      orgId: org.id,
      label,
      dismissedBy: who.appUserId ?? null,
      now: d.now(),
    });
    if (made)
      await emit(d, tx, {
        orgId: org.id,
        actor: { kind: "customer", userId: who.directusUserId },
        type: "room.hint_dismissed",
        detail: { label },
      });
  });
  return { dismissed_hints: hintsInOrder(await store.dismissedHints(d.db, org.id)) };
}

// ── the invitation ──────────────────────────────────────────────────────

/** The room row a valid token names; anything else reads as not found. */
async function invitedRow(d: AccountsDeps, orgId: string, token: string) {
  const org = isUuid(orgId) ? await store.org(d.db, orgId) : null;
  if (!org || org.deleted_at) throw new NotFoundError("invite.not_found");
  const hit = (await store.roomPeople(d.db, org.id)).find((r) => {
    const expected = roomInviteToken(d.settings.inviteSecret, r.row);
    return expected !== null && sameToken(expected, token);
  });
  if (!hit) throw new NotFoundError("invite.not_found");
  return { org, hit };
}

/** What the invitation page shows before anyone signs in. */
export async function roomInvite(d: AccountsDeps, orgId: string, token: string) {
  const { org, hit } = await invitedRow(d, orgId, token);
  const { row } = hit;
  const member = memberOf(await store.members(d.db, org.id), row);
  const status = member
    ? ("accepted" as const)
    : (await store.pendingOrgInvite(d.db, org.id, row.email, d.now()))
      ? ("open" as const)
      : ("closed" as const);
  return {
    organisation: { name: org.name },
    inviter: hit.inviterName ? { name: hit.inviterName } : null,
    person: { email: row.email, ...splitName(row.name) },
    labels: inOrder(row.labels),
    other: row.other,
    status,
    has_account: (await store.appUserByEmail(d.db, row.email)) !== null,
  };
}

/**
 * After the code sign-in: the verified address must be the one invited. Someone new keeps
 * the name they confirmed; the pending invitation is taken up as signing takes it up. An
 * invitation taken up from the dashboard's own invitation list works too, without this.
 */
export async function acceptRoomInvite(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  body: { invite: string; first_name: string; last_name: string | null },
) {
  const { org, hit } = await invitedRow(d, orgId, body.invite);
  const { row } = hit;
  const me = await store.identity(d.db, who.directusUserId);
  if (!me?.verified || me.email.toLowerCase() !== row.email)
    throw new ForbiddenError("invite.not_for_you");
  if (memberOf(await store.members(d.db, org.id), row)) return { org_id: org.id };
  const now = d.now();
  if (!(await store.pendingOrgInvite(d.db, org.id, row.email, now)))
    throw new NotFoundError("invite.not_found");
  await nameNewcomer(d, who, body);
  await d.db.transaction(async (tx) => {
    const appUserId = await joinByInvite(
      tx,
      org.id,
      { directusUserId: who.directusUserId, email: row.email },
      now,
    );
    // Withdrawn or lapsed since the check above: nothing was taken up.
    if (!appUserId) throw new NotFoundError("invite.not_found");
    await store.updateRoomPerson(tx, row.id, { appUserId, updatedAt: now });
    await emit(d, tx, {
      orgId: org.id,
      actor: { kind: "customer", userId: who.directusUserId },
      type: "room.invite_accepted",
      subject: { type: "room_person", id: row.id },
    });
  });
  await track(
    d,
    { email: me.email, directusUserId: who.directusUserId },
    "server_room_invite_accepted",
    {
      org_id: org.id,
      person_id: row.id,
    },
  );
  return { org_id: org.id };
}
