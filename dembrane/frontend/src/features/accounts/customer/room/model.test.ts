import { describe, expect, it } from "vitest";
import type { RoomPageT, RoomPersonT } from "../../contract/contract.gen";

// The rules of who does what, apart from the screens. The module is new in this slice
// (dashboard-plan.md, unit 1): ./model exports ROOM_LABELS, HINT_LABELS, decides,
// decisionSplit, openHints, outsideDomain, mayRemove, mayChangeLabels, roomPictures.
const load = () => import("./model");
/** One picture of roomPictures: the person, and whether they have joined. */
type Picture = { person: RoomPersonT; joined: boolean };

const ME = "0199a1b6-0000-7000-8000-000000000001";
const SAM = "0199a1b6-0000-7000-8000-000000000002";

const person = (
	name: string,
	over: Partial<RoomPersonT> = {},
): RoomPersonT => ({
	app_user_id: null,
	email: `${name.split(" ")[0]?.toLowerCase()}@example-town.example`,
	id: null,
	invited_at: null,
	invited_by: null,
	labels: [],
	labels_answered_at: null,
	name,
	org_role: "member",
	other: null,
	room: "by_invite",
	signs: [],
	status: "member",
	...over,
});

const robin = person("Robin Example", {
	app_user_id: ME,
	labels: ["go_ahead", "contract_purchasing"],
	org_role: "admin",
	room: "by_role",
});
const sam = person("Sam Example", {
	app_user_id: SAM,
	invited_by: { app_user_id: ME, name: "Robin Example" },
	labels: ["it_security"],
});
const noor = person("Noor Example", {
	id: "0199a1b8-0000-7000-8000-000000000003",
	invited_by: { app_user_id: ME, name: "Robin Example" },
	org_role: null,
	signs: ["offer"],
	status: "invited",
});
const eva = person("Eva Example", {
	invited_by: { app_user_id: SAM, name: "Sam Example" },
});
const bo = person("Bo Example", { org_role: "billing", room: "by_role" });
const kim = person("Kim Example", { room: "none" });
const otto = person("Otto Example", { other: "Wethouder" });

const page = (over: Partial<RoomPageT> = {}): RoomPageT => ({
	dismissed_hints: [],
	me: {
		app_user_id: ME,
		labels_question: false,
		may_dismiss_hints: true,
		may_invite_new: true,
		room: "by_role",
	},
	people: [robin, sam, noor, eva, bo, kim],
	signers: { dpa: null, offer: null },
	...over,
});

describe("the labels", () => {
	it("are the contract's six, in its order, without 'will use it'", async () => {
		const { ROOM_LABELS, HINT_LABELS } = await load();
		expect(ROOM_LABELS).toEqual([
			"go_ahead",
			"rollout",
			"it_security",
			"privacy_ai",
			"contract_purchasing",
			"staff_stakeholders",
		]);
		expect(HINT_LABELS).toEqual([
			"go_ahead",
			"it_security",
			"privacy_ai",
			"contract_purchasing",
		]);
	});
});

describe("the decision lens", () => {
	it("counts a label, Other or a signing duty as taking part, nothing else", async () => {
		const { decides } = await load();
		expect(decides(sam)).toBe(true);
		expect(decides(noor)).toBe(true);
		expect(decides(otto)).toBe(true);
		expect(decides(eva)).toBe(false);
		expect(decides(person("Blank", { other: "   " }))).toBe(false);
	});

	it("leads with signers, then the most decisive label, then by name; the rest by name", async () => {
		const { decisionSplit } = await load();
		const { lead, others } = decisionSplit([eva, sam, bo, robin, otto, noor]);
		// Noor signs; Robin gives the go-ahead; Sam checks IT; Otto has only Other.
		expect(lead.map((p: RoomPersonT) => p.name)).toEqual([
			"Noor Example",
			"Robin Example",
			"Sam Example",
			"Otto Example",
		]);
		expect(others.map((p: RoomPersonT) => p.name)).toEqual([
			"Bo Example",
			"Eva Example",
		]);
	});

	it("leaves out members who are not in the room", async () => {
		const { decisionSplit } = await load();
		const { lead, others } = decisionSplit(page().people);
		expect(
			[...lead, ...others].some((p: RoomPersonT) => p.room === "none"),
		).toBe(false);
		expect([...lead, ...others]).toHaveLength(5);
	});

	it("does not keep the person looking in the lead when they do nothing yet", async () => {
		const { decisionSplit } = await load();
		const meBlank = person("Me Example", { app_user_id: ME, room: "by_role" });
		const { lead, others } = decisionSplit([meBlank, sam]);
		expect(lead.map((p: RoomPersonT) => p.name)).toEqual(["Sam Example"]);
		expect(others.map((p: RoomPersonT) => p.name)).toEqual(["Me Example"]);
	});
});

describe("the 'nobody does this yet' hints", () => {
	it("names the hint labels nobody in the room holds, in the contract's order", async () => {
		const { openHints } = await load();
		// go_ahead and contract (Robin) and it_security (Sam) are held; privacy_ai is not.
		expect(openHints(page())).toEqual(["privacy_ai"]);
		expect(openHints(page({ people: [eva, bo] }))).toEqual([
			"go_ahead",
			"it_security",
			"privacy_ai",
			"contract_purchasing",
		]);
	});

	it("drops a hint once it is dismissed", async () => {
		const { openHints } = await load();
		expect(
			openHints(
				page({ dismissed_hints: ["go_ahead", "privacy_ai"], people: [eva] }),
			),
		).toEqual(["it_security", "contract_purchasing"]);
	});

	it("counts someone invited and not yet joined as holding their labels", async () => {
		const { openHints } = await load();
		const invitedPrivacy = person("Ilse Example", {
			labels: ["privacy_ai"],
			org_role: null,
			status: "invited",
		});
		expect(openHints(page({ people: [robin, sam, invitedPrivacy] }))).toEqual(
			[],
		);
	});

	it("never hints about labels outside the four", async () => {
		const { openHints } = await load();
		const hints = openHints(page({ people: [] }));
		expect(hints).not.toContain("rollout");
		expect(hints).not.toContain("staff_stakeholders");
	});
});

describe("an address outside the inviter's own domain", () => {
	it("is flagged with its domain", async () => {
		const { outsideDomain } = await load();
		expect(
			outsideDomain("robin@example-town.example", "anna@gmail.example"),
		).toBe("gmail.example");
	});

	it("is not flagged on the inviter's domain, whatever the case or spaces", async () => {
		const { outsideDomain } = await load();
		expect(
			outsideDomain(
				"robin@example-town.example",
				" Anna@Example-Town.example ",
			),
		).toBeNull();
	});

	it("is not flagged while the address is incomplete", async () => {
		const { outsideDomain } = await load();
		expect(outsideDomain("robin@example-town.example", "anna@")).toBeNull();
		expect(outsideDomain("robin@example-town.example", "")).toBeNull();
	});
});

describe("who may take someone out or change what they do", () => {
	const meAdmin = page().me as NonNullable<RoomPageT["me"]>;
	const meSam: NonNullable<RoomPageT["me"]> = {
		app_user_id: SAM,
		labels_question: false,
		may_dismiss_hints: false,
		may_invite_new: false,
		room: "by_invite",
	};

	it("lets those who run the account take out anyone brought in, never someone in by role", async () => {
		const { mayRemove } = await load();
		expect(mayRemove(meAdmin, noor)).toBe(true);
		expect(mayRemove(meAdmin, eva)).toBe(true);
		expect(mayRemove(meAdmin, bo)).toBe(false);
		expect(mayRemove(meAdmin, robin)).toBe(false);
	});

	it("lets a room member take out only the people they brought in", async () => {
		const { mayRemove } = await load();
		expect(mayRemove(meSam, eva)).toBe(true);
		expect(mayRemove(meSam, noor)).toBe(false);
	});

	it("lets nobody change their own labels here (the first-visit question does that)", async () => {
		const { mayChangeLabels } = await load();
		expect(mayChangeLabels(meAdmin, robin)).toBe(false);
		expect(mayChangeLabels(meAdmin, sam)).toBe(true);
		expect(mayChangeLabels(meAdmin, bo)).toBe(true);
		expect(mayChangeLabels(meSam, eva)).toBe(true);
		expect(mayChangeLabels(meSam, noor)).toBe(false);
	});
});

describe("the pictures in the top corner", () => {
	it("show the room's people, those who take part first, and mark who has joined", async () => {
		const { roomPictures } = await load();
		const pics = roomPictures(page().people);
		expect(pics.map((p: Picture) => p.person.name)).toEqual([
			"Noor Example",
			"Robin Example",
			"Sam Example",
			"Bo Example",
			"Eva Example",
		]);
		expect(pics.map((p: Picture) => p.joined)).toEqual([
			false,
			true,
			true,
			true,
			true,
		]);
	});
});
