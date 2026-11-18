import type { z } from "zod4";
import {
	HintLabel,
	RoomLabel,
	type RoomLabelT,
	type RoomPageT,
	type RoomPersonT,
} from "../../contract/contract.gen";

/**
 * The rules of who does what in the data room, apart from the screens: who leads the
 * list, which "nobody does this yet" hint shows, who may take someone out or change what
 * they do. Everything here reads the contract's own types; signing comes from
 * `RoomPerson.signs`, never from a label.
 */

export type HintLabelT = z.output<typeof HintLabel>;
export type RoomMe = NonNullable<RoomPageT["me"]>;
export type SignKind = RoomPersonT["signs"][number];

/** The six labels, in the contract's order: the order they are offered and said in. */
export const ROOM_LABELS: readonly RoomLabelT[] = RoomLabel.options;
/** The labels whose absence can stop a deal, in the server's order. */
export const HINT_LABELS: readonly HintLabelT[] = HintLabel.options;

/** Two ways to order the same people: by what they do in the decision, or by org role. */
export type Lens = "decision" | "access";

// Enough to catch a slip; the server has the final word.
export const looksLikeEmail = (v: string) =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** The labels in the contract's order, whatever order they were chosen in. */
export const inLabelOrder = (labels: readonly RoomLabelT[]): RoomLabelT[] =>
	ROOM_LABELS.filter((l) => labels.includes(l));

const otherOf = (p: Pick<RoomPersonT, "other">) => p.other?.trim() ?? "";

/** Taking part in the decision: a label, their own words for Other, or a signing duty. */
export const decides = (p: RoomPersonT): boolean =>
	p.labels.length > 0 || otherOf(p) !== "" || p.signs.length > 0;

const signRank = (p: RoomPersonT) =>
	p.signs.includes("offer") ? 0 : p.signs.includes("dpa") ? 1 : 2;
/** The most decisive label they hold, by its place in the contract; Other only comes last. */
const labelRank = (p: RoomPersonT) => {
	const ranks = p.labels.map((l) => ROOM_LABELS.indexOf(l));
	return ranks.length ? Math.min(...ranks) : ROOM_LABELS.length;
};
const byName = (a: RoomPersonT, b: RoomPersonT) => a.name.localeCompare(b.name);

/**
 * The decision lens: those who take part lead (signers, offer before the DPA, then the
 * most decisive label, then Other only, then by name); everyone else in the room follows
 * by name. Members who are not in the room are left out.
 */
export function decisionSplit(people: RoomPersonT[]): {
	lead: RoomPersonT[];
	others: RoomPersonT[];
} {
	const inRoom = people.filter((p) => p.room !== "none");
	const lead = inRoom
		.filter(decides)
		.sort(
			(a, b) =>
				signRank(a) - signRank(b) ||
				labelRank(a) - labelRank(b) ||
				byName(a, b),
		);
	const others = inRoom.filter((p) => !decides(p)).sort(byName);
	return { lead, others };
}

/** Members of the organisation who are not in the room yet, by name. */
export const notInRoom = (people: RoomPersonT[]): RoomPersonT[] =>
	people.filter((p) => p.room === "none").sort(byName);

const ROLE_ORDER = ["owner", "admin", "billing", "member"] as const;
/** The access lens: by org role (owner, admin, Billing, member), then by name. */
export const accessOrder = (people: RoomPersonT[]): RoomPersonT[] =>
	[...people].sort(
		(a, b) =>
			(a.org_role ? ROLE_ORDER.indexOf(a.org_role) : ROLE_ORDER.length) -
				(b.org_role ? ROLE_ORDER.indexOf(b.org_role) : ROLE_ORDER.length) ||
			byName(a, b),
	);

/**
 * The hint labels nobody in the room holds yet (an invitation not yet taken up counts),
 * less those dismissed, in the server's order. The list shows the first.
 */
export function openHints(page: RoomPageT): HintLabelT[] {
	const held = new Set(
		page.people.filter((p) => p.room !== "none").flatMap((p) => p.labels),
	);
	return HINT_LABELS.filter(
		(l) => !held.has(l) && !page.dismissed_hints.includes(l),
	);
}

const domainOf = (email: string) =>
	email.trim().toLowerCase().split("@")[1] ?? "";

/**
 * The domain of an address outside the inviter's own, or null: on their domain, or while
 * the address is not complete. A hint to look twice, never a block.
 */
export function outsideDomain(
	inviterEmail: string,
	email: string,
): string | null {
	if (!looksLikeEmail(email)) return null;
	const theirs = domainOf(email);
	return theirs && theirs !== domainOf(inviterEmail) ? theirs : null;
}

const isMe = (me: RoomMe, p: RoomPersonT) =>
	p.app_user_id !== null && p.app_user_id === me.app_user_id;
const brought = (me: RoomMe, p: RoomPersonT) =>
	p.invited_by?.app_user_id === me.app_user_id;

/**
 * Taking someone out: only someone brought in by an invitation (nobody takes out someone
 * in by their role), by those who run the account or by whoever brought them in.
 */
export const mayRemove = (me: RoomMe, p: RoomPersonT): boolean =>
	p.room === "by_invite" && (me.room === "by_role" || brought(me, p));

/**
 * Changing what someone in the room does: never one's own (the first-visit question asks
 * that once), by those who run the account or by whoever brought them in.
 */
export const mayChangeLabels = (me: RoomMe, p: RoomPersonT): boolean =>
	p.room !== "none" &&
	!isMe(me, p) &&
	(me.room === "by_role" || brought(me, p));

/**
 * Who may name or change a signer. The server lets only owners and admins do it, the same
 * two roles as `may_invite_new`; it will say so in its own field (`may_name_signer`), and
 * this is the one place to read it then.
 */
export const mayNameSigner = (me: RoomMe | null | undefined): boolean =>
	me?.may_invite_new ?? false;

/** The pictures in the page's top corner: the room's people, in the decision lens's order. */
export function roomPictures(
	people: RoomPersonT[],
): { person: RoomPersonT; joined: boolean }[] {
	const { lead, others } = decisionSplit(people);
	return [...lead, ...others].map((person) => ({
		joined: person.status === "member",
		person,
	}));
}

/** The first name, for sentences about someone. */
export const firstName = (p: Pick<RoomPersonT, "name" | "email">) =>
	p.name.trim().split(/\s+/)[0] || p.email;
