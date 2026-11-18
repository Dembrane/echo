import { i18n } from "@lingui/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RoomPersonT } from "../../contract/contract.gen";

// The words of who does what, said as sentences. New in this slice (dashboard-plan.md,
// unit 1): ./copy exports labelText, labelPhrase, hintText, signText, joinAnd,
// invitedSentence and removeConsequence. Dutch comes from the compiled accounts catalog,
// so the Dutch cases also need the translations (unit 13).
const load = () => import("./copy");

const english = () => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
};
const dutch = async () => {
	const { messages } = await import("../../locales/nl-NL");
	i18n.load("nl-NL", messages);
	i18n.activate("nl-NL");
};

beforeEach(english);
afterAll(english);

const inviter = "Anna Bakker";

describe("the first-visit question, in English", () => {
	it("says one label as a phrase, never the tag", async () => {
		const { invitedSentence } = await load();
		const s = invitedSentence({ inviter, labels: ["rollout"], other: null });
		expect(s).toBe("Anna Bakker invited you to run the rollout.");
		expect(s).not.toContain("Will run the rollout");
	});

	it("joins two labels with 'and'", async () => {
		const { invitedSentence } = await load();
		expect(
			invitedSentence({
				inviter,
				labels: ["go_ahead", "rollout"],
				other: null,
			}),
		).toBe("Anna Bakker invited you to give the go-ahead and run the rollout.");
	});

	it("lists three in the contract's order, with commas and a last 'and'", async () => {
		const { invitedSentence } = await load();
		expect(
			invitedSentence({
				inviter,
				labels: ["it_security", "go_ahead", "rollout"],
				other: null,
			}),
		).toBe(
			"Anna Bakker invited you to give the go-ahead, run the rollout and check IT and security.",
		);
	});

	it("asks what they do when there are no labels", async () => {
		const { invitedSentence } = await load();
		expect(invitedSentence({ inviter, labels: [], other: null })).toBe(
			"Anna Bakker invited you. What do you do in this decision?",
		);
	});

	it("closes with their own words for Other, in quotes", async () => {
		const { invitedSentence } = await load();
		expect(
			invitedSentence({ inviter, labels: ["rollout"], other: "Wethouder" }),
		).toBe("Anna Bakker invited you to run the rollout, and as “Wethouder”.");
		expect(invitedSentence({ inviter, labels: [], other: "Wethouder" })).toBe(
			"Anna Bakker invited you as “Wethouder”.",
		);
	});

	it("says it without a name when the inviter is unknown", async () => {
		const { invitedSentence } = await load();
		expect(
			invitedSentence({ inviter: null, labels: ["rollout"], other: null }),
		).toBe("You were invited to run the rollout.");
	});
});

describe("the first-visit question, in Dutch", () => {
	it("says one label as a phrase", async () => {
		await dutch();
		const { invitedSentence } = await load();
		expect(invitedSentence({ inviter, labels: ["rollout"], other: null })).toBe(
			"Anna Bakker heeft je uitgenodigd om de invoering te leiden.",
		);
	});

	it("joins two labels with 'en'", async () => {
		await dutch();
		const { invitedSentence } = await load();
		expect(
			invitedSentence({
				inviter,
				labels: ["go_ahead", "rollout"],
				other: null,
			}),
		).toBe(
			"Anna Bakker heeft je uitgenodigd om groen licht te geven en de invoering te leiden.",
		);
	});

	it("lists three with commas and a last 'en'", async () => {
		await dutch();
		const { invitedSentence } = await load();
		expect(
			invitedSentence({
				inviter,
				labels: ["go_ahead", "rollout", "it_security"],
				other: null,
			}),
		).toBe(
			"Anna Bakker heeft je uitgenodigd om groen licht te geven, de invoering te leiden en IT en beveiliging te checken.",
		);
	});

	it("asks what they do when there are no labels", async () => {
		await dutch();
		const { invitedSentence } = await load();
		expect(invitedSentence({ inviter, labels: [], other: null })).toBe(
			"Anna Bakker heeft je uitgenodigd. Wat doe je bij dit besluit?",
		);
	});
});

describe("the words for labels, hints and signing", () => {
	it("names each label as its tag and signing as a fixed marker", async () => {
		const { labelText, signText } = await load();
		expect(labelText("go_ahead")).toBe("Gives the go-ahead");
		expect(labelText("rollout")).toBe("Will run the rollout");
		expect(labelText("it_security")).toBe("Checks IT and security");
		expect(labelText("privacy_ai")).toBe("Checks privacy and AI rules");
		expect(labelText("contract_purchasing")).toBe(
			"Handles contract and purchasing",
		);
		expect(labelText("staff_stakeholders")).toBe(
			"Represents staff or stakeholders",
		);
		expect(signText("offer")).toBe("Signs the offer");
		expect(signText("dpa")).toBe("Signs the DPA");
	});

	it("says each hint as a plain fact", async () => {
		const { hintText } = await load();
		expect(hintText("go_ahead")).toBe("Nobody gives the go-ahead yet.");
		expect(hintText("it_security")).toBe("Nobody checks IT and security yet.");
		expect(hintText("privacy_ai")).toBe(
			"Nobody checks privacy and AI rules yet.",
		);
		expect(hintText("contract_purchasing")).toBe(
			"Nobody handles contract and purchasing yet.",
		);
	});
});

describe("what taking someone out does", () => {
	const base: RoomPersonT = {
		app_user_id: null,
		email: "noor@example-town.example",
		id: "0199a1b8-0000-7000-8000-000000000003",
		invited_at: "2026-09-28T10:05:00.000Z",
		invited_by: null,
		labels: [],
		labels_answered_at: null,
		may_relabel: false,
		may_remove: false,
		name: "Noor Example",
		org_role: null,
		other: null,
		room: "by_invite",
		signs: [],
		status: "invited",
	};

	it("withdraws the invitation of someone who has not joined", async () => {
		const { removeConsequence } = await load();
		expect(removeConsequence(base)).toBe(
			"Noor's invitation is withdrawn and the link we sent stops working.",
		);
	});

	it("keeps the membership of someone who joined and takes the room away", async () => {
		const { removeConsequence } = await load();
		expect(
			removeConsequence({
				...base,
				app_user_id: "0199a1b6-0000-7000-8000-000000000009",
				org_role: "member",
				status: "member",
			}),
		).toBe(
			"Noor stays a member of your organisation, but can no longer read the offer and the DPA here.",
		);
	});
});
