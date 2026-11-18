import { t } from "@lingui/core/macro";
import type { RoomLabelT, RoomPersonT } from "../../contract/contract.gen";
import {
	firstName,
	type HintLabelT,
	inLabelOrder,
	type SignKind,
} from "./model";

/** The words of who does what. Call during render (they read the active language). */

/** A label as its tag: "Gives the go-ahead". */
export const labelText = (label: RoomLabelT): string =>
	({
		contract_purchasing: t`Handles contract`,
		go_ahead: t`Gives the go-ahead`,
		it_security: t`Checks IT and security`,
		privacy_ai: t`Checks privacy and AI rules`,
		rollout: t`Will run the rollout`,
		staff_stakeholders: t`Represents staff or stakeholders`,
	})[label];

/**
 * A label as the end of "invited you to {this}". English drops the "to" (the sentence has
 * it); Dutch ends each part on its verb ("groen licht te geven").
 */
export const labelPhrase = (label: RoomLabelT): string =>
	({
		contract_purchasing: t`handle the contract`,
		go_ahead: t`give the go-ahead`,
		it_security: t`check IT and security`,
		privacy_ai: t`check privacy and AI rules`,
		rollout: t`run the rollout`,
		staff_stakeholders: t`represent staff or stakeholders`,
	})[label];

/** The hint under the list, as a plain fact. */
export const hintText = (label: HintLabelT): string =>
	({
		contract_purchasing: t`Nobody handles the contract yet.`,
		go_ahead: t`Nobody gives the go-ahead yet.`,
		it_security: t`Nobody checks IT and security yet.`,
		privacy_ai: t`Nobody checks privacy and AI rules yet.`,
	})[label];

/** The signing marker: never a label, a fixed duty from the signer model. */
export const signText = (kind: SignKind): string =>
	({
		dpa: t`Signs the DPA`,
		offer: t`Signs the offer`,
	})[kind];

/** "a, b and c": commas, then "and" before the last, without a comma before it. */
export function joinAnd(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	const and = t`and`;
	return `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`;
}

/**
 * What someone was invited to do, as one sentence, for their first visit: their labels in
 * the contract's order, then their own words for Other in quotes. Signing is left out (the
 * marker says it). With nothing set, it asks what they do.
 */
export function invitedSentence({
	inviter,
	labels,
	other,
}: {
	inviter: string | null;
	labels: readonly RoomLabelT[];
	other: string | null;
}): string {
	const what = joinAnd(inLabelOrder(labels).map(labelPhrase));
	const own = other?.trim() ?? "";
	const who = inviter ?? "";
	if (!what && !own)
		return inviter
			? t`${who} invited you. What do you do in this decision?`
			: t`You were invited. What do you do in this decision?`;
	if (!what)
		return inviter
			? t`${who} invited you as “${own}”.`
			: t`You were invited as “${own}”.`;
	if (own)
		return inviter
			? t`${who} invited you to ${what}, and as “${own}”.`
			: t`You were invited to ${what}, and as “${own}”.`;
	return inviter
		? t`${who} invited you to ${what}.`
		: t`You were invited to ${what}.`;
}

/**
 * What taking someone out does: before they joined, the invitation goes and its link
 * stops; after, they keep their membership and lose the room.
 */
export function removeConsequence(p: RoomPersonT): string {
	const first = firstName(p);
	return p.status === "invited"
		? t`${first}'s invitation is withdrawn and the link we sent stops working.`
		: t`${first} stays a member of your organisation, but can no longer read the offer and the DPA here.`;
}

/**
 * Taking out someone named to sign leaves the signing with them: the server keeps them
 * the named signer (their signing link still works), so someone else is chosen on the
 * document. Null for someone who signs nothing.
 */
export function removeSigning(p: RoomPersonT): string | null {
	const first = firstName(p);
	if (p.signs.length === 2)
		return t`${first} still signs the offer and the DPA. Choose someone else to sign them after this.`;
	if (p.signs[0] === "offer")
		return t`${first} still signs the offer. Choose someone else to sign it after this.`;
	if (p.signs[0] === "dpa")
		return t`${first} still signs the DPA. Choose someone else to sign it after this.`;
	return null;
}
