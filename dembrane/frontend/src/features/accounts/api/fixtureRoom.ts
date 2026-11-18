import { invite as inviteCodes } from "@/lib/errors/catalog/invite.gen";
import { room as roomCodes } from "@/lib/errors/catalog/room.gen";
import {
	HintLabel,
	RoomLabel,
	type RoomLabelT,
	type RoomPageT,
	type RoomPersonT,
} from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";
import { AccountsApiError } from "./client";

/**
 * The data room in fixture mode, by the server's rules (platform/packages/accounts/src/
 * room.ts and access.ts): who is in the room by role, by invitation or not at all, who may
 * bring whom in, take whom out and change what they do, and the once-asked labels question.
 * The person asking is the fixture actor: Robin (admin), Bo (Billing), Sam (a member Robin
 * brought in) or Kim (a member outside the room). The harness picks one with `?as=`.
 */

export type Actor = "admin" | "billing" | "colleague" | "member";
type Role = NonNullable<RoomPersonT["org_role"]>;
type Hint = (typeof HintLabel.options)[number];

export interface RoomMember {
	app_user_id: string;
	name: string;
	email: string;
	role: Role;
}
export interface RoomRow {
	id: string;
	email: string;
	name: string;
	labels: RoomLabelT[];
	other: string | null;
	/** Set: they read the offer and the DPA (while a member or invited). Null: labels only. */
	access_granted_at: string | null;
	invited_by: { app_user_id: string; name: string } | null;
	labels_answered_at: string | null;
}
export interface RoomState {
	members: RoomMember[];
	rows: RoomRow[];
	/** Addresses invited to the organisation who have not joined yet. */
	invites: string[];
	dismissed: Hint[];
	/** How many workspaces someone new reaches once they join (those every member joins). */
	workspaces_reached: number;
	/** Who signs, until a document names someone itself. */
	signers: { offer: Signer | null; dpa: Signer | null };
}
type Signer = { document_id: string; email: string; name: string | null };

const ROBIN = fx.roomPage.people.find((p) => p.org_role === "admin");
const SAM = fx.roomPageAsColleague.me?.app_user_id as string;
const BILLING_APP_USER = "0199a1b6-0000-7000-8000-000000000004";

/** The four people the fixtures can be. */
export const ACTORS: Record<Actor, { app_user_id: string; email: string }> = {
	admin: {
		app_user_id: ROBIN?.app_user_id as string,
		email: ROBIN?.email as string,
	},
	billing: {
		app_user_id: BILLING_APP_USER,
		email: "billing@example-town.example",
	},
	colleague: { app_user_id: SAM, email: "sam@example-town.example" },
	member: {
		app_user_id: fx.roomPage.people.find((p) => p.room === "none")
			?.app_user_id as string,
		email: "kim@example-town.example",
	},
};

const ACTOR_KEY = "echo.accounts.fixtures.actor";
let actor: Actor | null = null;

const isActor = (v: unknown): v is Actor =>
	v === "admin" || v === "billing" || v === "colleague" || v === "member";

/** Who the fixtures answer as: set here, or `?as=` on the page, kept for the session. */
export function fixtureActor(): Actor {
	if (actor) return actor;
	try {
		const fromUrl = new URLSearchParams(window.location.search).get("as");
		if (isActor(fromUrl)) sessionStorage.setItem(ACTOR_KEY, fromUrl);
		const stored = sessionStorage.getItem(ACTOR_KEY);
		actor = isActor(stored) ? stored : "admin";
	} catch {
		actor = "admin";
	}
	return actor;
}

export function setFixtureActor(next: Actor) {
	actor = next;
	try {
		sessionStorage.setItem(ACTOR_KEY, next);
	} catch {}
}

/** The seeded room: Robin, Sam, Noor (invited) and Kim from the contract fixtures, and Bo. */
export function seedRoom(): RoomState {
	const people = fx.roomPage.people;
	const members: RoomMember[] = people
		.filter((p) => p.org_role !== null && p.app_user_id !== null)
		.map((p) => ({
			app_user_id: p.app_user_id as string,
			email: p.email,
			name: p.name,
			role: p.org_role as Role,
		}));
	members.push({
		app_user_id: BILLING_APP_USER,
		email: ACTORS.billing.email,
		name: "Bo Example",
		role: "billing",
	});
	const rows: RoomRow[] = people
		.filter((p) => p.id !== null)
		.map((p) => ({
			access_granted_at:
				p.room === "by_invite" ? (p.invited_at ?? now()) : null,
			email: p.email,
			id: p.id as string,
			invited_by: p.invited_by,
			labels: [...p.labels],
			labels_answered_at: p.labels_answered_at,
			name: p.name,
			other: p.other,
		}));
	return {
		dismissed: [...fx.roomPage.dismissed_hints],
		invites: people.filter((p) => p.status === "invited").map((p) => p.email),
		members,
		rows,
		signers: {
			dpa: fx.roomPage.signers.dpa,
			offer: fx.roomPage.signers.offer,
		},
		workspaces_reached: 2,
	};
}

const now = () => new Date().toISOString();
const runsAccount = (role: Role | null | undefined) =>
	role === "owner" || role === "admin" || role === "billing";
const mayInviteNew = (role: Role | null | undefined) =>
	role === "owner" || role === "admin";
const inOrder = (labels: readonly RoomLabelT[]) =>
	RoomLabel.options.filter((l) => labels.includes(l));
const hintsInOrder = (hints: readonly Hint[]) =>
	HintLabel.options.filter((l) => hints.includes(l));

/** A refusal as the API sends it: the catalog's code, action and detail. */
function refuse(status: number, code: string): AccountsApiError {
	const entry = (
		{ ...roomCodes, ...inviteCodes } as Record<
			string,
			{ action: string; detail: string }
		>
	)[code];
	const detail = entry?.detail ?? code;
	return new AccountsApiError(
		status,
		detail,
		{},
		{
			action: entry?.action ?? "none",
			code,
			detail,
			params: {},
		},
	);
}
export const forbidden = () => new AccountsApiError(403, "Forbidden");

const me = () => ACTORS[fixtureActor()];
const memberByEmail = (r: RoomState, email: string) =>
	r.members.find((m) => m.email === email);
const rowOf = (r: RoomState, email: string) =>
	r.rows.find((x) => x.email === email);
const myRole = (r: RoomState) =>
	r.members.find((m) => m.app_user_id === me().app_user_id)?.role ?? null;

/** How the actor reaches the room: running the account, a room member, or not at all. */
export function roomAccess(r: RoomState): "account" | "room" | null {
	const role = myRole(r);
	if (runsAccount(role)) return "account";
	if (!role) return null;
	return rowOf(r, me().email)?.access_granted_at ? "room" : null;
}

/** Naming or changing a signer: owners and admins (the server's may_name_signer). */
export const mayNameSigner = (r: RoomState) => mayInviteNew(myRole(r));

/** The refusal of naming a signer by anyone else. */
export const nameSignerRefused = () =>
	refuse(403, "room.name_signer_admins_only");

/** account:room: those who run the account and room members; a plain member gets 403. */
export function requireRoom(r: RoomState) {
	const via = roomAccess(r);
	if (!via) throw forbidden();
	return via;
}

const manages = (r: RoomState, row: RoomRow | undefined) =>
	roomAccess(r) === "account" ||
	row?.invited_by?.app_user_id === me().app_user_id;

function people(r: RoomState): RoomPersonT[] {
	const view = (
		row: RoomRow | undefined,
		who: {
			app_user_id: string | null;
			name: string;
			email: string;
			role: Role | null;
			room: RoomPersonT["room"];
		},
	): RoomPersonT => ({
		app_user_id: who.app_user_id,
		email: who.email,
		id: row?.id ?? null,
		invited_at: row?.access_granted_at ?? null,
		invited_by: row?.invited_by ?? null,
		labels: inOrder(row?.labels ?? []),
		labels_answered_at: row?.labels_answered_at ?? null,
		name: who.name,
		org_role: who.role,
		other: row?.other ?? null,
		room: who.room,
		signs: (["offer", "dpa"] as const).filter(
			(k) => r.signers[k]?.email === who.email,
		),
		status: who.role ? "member" : "invited",
	});
	const out: RoomPersonT[] = [];
	for (const m of r.members) {
		const row = rowOf(r, m.email);
		const room = runsAccount(m.role)
			? "by_role"
			: row?.access_granted_at
				? "by_invite"
				: "none";
		out.push(view(row, { ...m, room }));
	}
	for (const row of r.rows)
		if (
			!memberByEmail(r, row.email) &&
			row.access_granted_at &&
			r.invites.includes(row.email)
		)
			out.push(
				view(row, {
					app_user_id: null,
					email: row.email,
					name: row.name,
					role: null,
					room: "by_invite",
				}),
			);
	return out;
}

const asksLabels = (row: RoomRow | undefined) =>
	Boolean(
		row?.invited_by &&
			row.invited_by.app_user_id !== me().app_user_id &&
			!row.labels_answered_at,
	);

export function roomPage(r: RoomState): RoomPageT {
	const via = requireRoom(r);
	const all = people(r);
	return {
		dismissed_hints: hintsInOrder(r.dismissed),
		me: {
			app_user_id: me().app_user_id,
			labels_question: asksLabels(rowOf(r, me().email)),
			may_dismiss_hints: via === "account",
			may_invite_new: mayInviteNew(myRole(r)),
			room: via === "room" ? "by_invite" : "by_role",
		},
		people: via === "room" ? all.filter((p) => p.room !== "none") : all,
		signers: { dpa: r.signers.dpa, offer: r.signers.offer },
	};
}

/** The staff side reads the room as an admin would, with no `me`. */
export const staffRoomPage = (r: RoomState): RoomPageT => ({
	dismissed_hints: hintsInOrder(r.dismissed),
	me: null,
	people: people(r),
	signers: { dpa: r.signers.dpa, offer: r.signers.offer },
});

const personOf = (r: RoomState, email: string) =>
	people(r).find((p) => p.email === email) as RoomPersonT;

export function addRoomPerson(
	r: RoomState,
	body: {
		email: string;
		name: string;
		labels: RoomLabelT[];
		other: string | null;
	},
) {
	requireRoom(r);
	const email = body.email.trim().toLowerCase();
	if (email === me().email) throw refuse(400, "invite.self");
	const labels = inOrder(body.labels);
	const member = memberByEmail(r, email);
	const row = rowOf(r, email);
	const pending = !member && r.invites.includes(email);
	const done = (
		status: "invited" | "added" | "updated",
		sent: boolean,
		workspaces: number | null = null,
	) => ({
		email_sent: sent,
		person: personOf(r, email),
		status,
		workspaces_reached: workspaces,
	});
	const inByRole = member && runsAccount(member.role);
	const inRoomAlready = row?.access_granted_at && (member || pending);
	if (inByRole || inRoomAlready) {
		if (!manages(r, row)) throw refuse(403, "room.manage_forbidden");
		if (row) Object.assign(row, { labels, other: body.other });
		else
			r.rows.push({
				access_granted_at: null,
				email,
				id: crypto.randomUUID(),
				invited_by: inviter(r),
				labels,
				labels_answered_at: null,
				name: body.name,
				other: body.other,
			});
		return done("updated", false);
	}
	if (!member && !mayInviteNew(myRole(r)))
		throw refuse(403, "room.new_person_admins_only");
	const granted = {
		access_granted_at: now(),
		invited_by: inviter(r),
		labels,
		labels_answered_at: null,
		name: body.name,
		other: body.other,
	};
	if (row) Object.assign(row, granted);
	else r.rows.push({ email, id: crypto.randomUUID(), ...granted });
	if (!member && !r.invites.includes(email)) r.invites.push(email);
	return member
		? done("added", true)
		: done("invited", true, r.workspaces_reached);
}

const inviter = (r: RoomState) => ({
	app_user_id: me().app_user_id,
	name: r.members.find((m) => m.app_user_id === me().app_user_id)?.name ?? "",
});

export function removeRoomPerson(r: RoomState, personId: string) {
	requireRoom(r);
	const row = r.rows.find((x) => x.id === personId);
	if (!row) throw refuse(404, "room.person_not_found");
	const member = memberByEmail(r, row.email);
	if (member && runsAccount(member.role)) throw refuse(409, "room.in_by_role");
	if (!row.access_granted_at) throw refuse(404, "room.person_not_found");
	if (!manages(r, row)) throw refuse(403, "room.remove_forbidden");
	r.rows = r.rows.filter((x) => x.id !== row.id);
	if (!member) r.invites = r.invites.filter((e) => e !== row.email);
	return {
		membership: member ? ("kept" as const) : ("withdrawn" as const),
		status: "removed" as const,
	};
}

export function answerRoomLabels(
	r: RoomState,
	body: { labels: RoomLabelT[]; other: string | null },
) {
	requireRoom(r);
	const row = rowOf(r, me().email);
	if (!row || !asksLabels(row)) {
		if (row?.labels_answered_at)
			throw refuse(409, "room.labels_already_answered");
		throw refuse(409, "room.no_labels_question");
	}
	Object.assign(row, {
		labels: inOrder(body.labels),
		labels_answered_at: now(),
		other: body.other,
	});
	return personOf(r, row.email);
}

export function dismissRoomHint(r: RoomState, label: string) {
	if (roomAccess(r) !== "account") throw forbidden();
	if (
		(HintLabel.options as readonly string[]).includes(label) &&
		!r.dismissed.includes(label as Hint)
	)
		r.dismissed.push(label as Hint);
	return { dismissed_hints: hintsInOrder(r.dismissed) };
}

/** The invitation page reads Noor's invitation for any token; `closed` reads closed. */
const INVITED = "noor@example-town.example";

export function roomInvite(r: RoomState, orgName: string, token: string) {
	const row = rowOf(r, INVITED);
	if (!row) throw refuse(404, "invite.not_found");
	const [first, ...rest] = row.name.split(" ");
	const status = memberByEmail(r, row.email)
		? ("accepted" as const)
		: token.startsWith("closed") || !r.invites.includes(row.email)
			? ("closed" as const)
			: ("open" as const);
	return {
		has_account: false,
		inviter: row.invited_by ? { name: row.invited_by.name } : null,
		labels: inOrder(row.labels),
		organisation: { name: orgName },
		other: row.other,
		person: {
			email: row.email,
			first_name: first ?? "",
			last_name: rest.join(" "),
		},
		status,
	};
}

export function acceptRoomInvite(
	r: RoomState,
	orgId: string,
	body: { invite: string; first_name: string; last_name: string | null },
) {
	const row = rowOf(r, INVITED);
	if (!row) throw refuse(404, "invite.not_found");
	if (memberByEmail(r, row.email)) return { org_id: orgId };
	if (body.invite.startsWith("closed") || !r.invites.includes(row.email))
		throw refuse(404, "invite.not_found");
	r.members.push({
		app_user_id: crypto.randomUUID(),
		email: row.email,
		name: [body.first_name, body.last_name].filter(Boolean).join(" "),
		role: "member",
	});
	r.invites = r.invites.filter((e) => e !== row.email);
	return { org_id: orgId };
}

/** A named signer replaces the seeded one, as the signer model does. */
export function nameRoomSigner(
	r: RoomState,
	kind: "offer" | "dpa",
	signer: Signer,
) {
	r.signers[kind] = { ...signer, email: signer.email.toLowerCase() };
}
