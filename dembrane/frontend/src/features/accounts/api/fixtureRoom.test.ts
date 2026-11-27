// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomLabelT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

i18n.load("en-US", {});
i18n.activate("en-US");

/**
 * The fixture backend serves the room routes by the same access rules as the server
 * (platform/packages/accounts/test/room-*.test.ts), so the harness and
 * VITE_ACCOUNTS_FIXTURES=1 show what each person would really see. fixtureBackend exports
 * setFixtureActor(actor), actor one of "admin" (Robin, the fixtures' admin), "billing" (a
 * Billing member the store adds), "colleague" (Sam, brought into the room by Robin),
 * "member" (Kim, a member outside the room) and "invitee" (Noor, invited, not joined).
 * resetFixtures() also sets the actor back to "admin". Refusals carry the catalog's code
 * in the error body.
 */

type Actor = "admin" | "billing" | "colleague" | "member" | "invitee";

describe("the fixture backend's room", () => {
	let client: typeof import("./client");
	let backend: typeof import("./fixtureBackend");
	const orgId = fx.accountPage.organisation.id;
	const params = { orgId };
	const as = (actor: Actor) =>
		(
			backend as unknown as { setFixtureActor: (a: Actor) => void }
		).setFixtureActor(actor);
	const room = () => client.call("roomPage", { params });
	const page = () => client.call("accountPage", { params });
	const add = (email: string, name: string, labels: string[] = []) =>
		client.call("addRoomPerson", {
			body: {
				email,
				labels: labels as never,
				name,
				other: null,
			},
			params,
		});
	const refused = (status: number, code: string) => ({
		body: expect.objectContaining({ code }),
		status,
	});
	const personId = (email: string) =>
		fx.roomPage.people.find((p) => p.email === email)?.id as string;

	beforeAll(async () => {
		vi.stubEnv("VITE_ACCOUNTS_FIXTURES", "1");
		client = await import("./client");
		backend = await import("./fixtureBackend");
		expect(client.FIXTURE_MODE).toBe(true);
	});
	beforeEach(() => {
		backend.resetFixtures();
		as("admin");
	});

	describe("the room page", () => {
		it("shows those who run the account every member, and what they may do", async () => {
			const r = await room();
			expect(r.people.map((p) => p.email)).toEqual(
				expect.arrayContaining(fx.roomPage.people.map((p) => p.email)),
			);
			expect(r.me).toMatchObject({
				may_dismiss_hints: true,
				may_invite_new: true,
				room: "by_role",
			});
		});

		it("shows a room member the room's people only, and asks them about their labels", async () => {
			as("colleague");
			const r = await room();
			expect(r.people.some((p) => p.room === "none")).toBe(false);
			expect(r.people.some((p) => p.email === "kim@example-town.example")).toBe(
				false,
			);
			expect(r.me).toMatchObject({
				labels_question: true,
				may_dismiss_hints: false,
				may_invite_new: false,
				room: "by_invite",
			});
		});

		it("lets Billing dismiss hints but not invite someone new", async () => {
			as("billing");
			expect((await room()).me).toMatchObject({
				may_dismiss_hints: true,
				may_invite_new: false,
				room: "by_role",
			});
		});

		it("says per person whether the one looking may take them out or change what they do", async () => {
			const may = async (email: string) => {
				const p = (await room()).people.find((x) => x.email === email);
				return [p?.may_remove, p?.may_relabel];
			};
			expect(await may("noor@example-town.example")).toEqual([true, true]);
			expect(await may("sam@example-town.example")).toEqual([true, true]);
			expect(await may("billing@example-town.example")).toEqual([false, true]);
			// Their own labels, never themselves out.
			expect(await may("robin@example-town.example")).toEqual([false, true]);
			expect(await may("kim@example-town.example")).toEqual([false, false]);
			as("colleague");
			for (const p of (await room()).people)
				expect([p.email, p.may_remove, p.may_relabel]).toEqual([
					p.email,
					false,
					p.email === "sam@example-town.example",
				]);
		});

		it("refuses a member outside the room, the account page included", async () => {
			as("member");
			await expect(room()).rejects.toMatchObject({ status: 403 });
			await expect(page()).rejects.toMatchObject({ status: 403 });
		});
	});

	describe("a room member's account", () => {
		it("reads the offer and the DPA, without billing details, questions or an early download", async () => {
			as("colleague");
			const p = await page();
			expect(p.access).toBe("room");
			expect(new Set(p.documents.map((d) => d.kind))).toEqual(
				new Set(["offer", "dpa"]),
			);
			const offer = p.documents.find((d) => d.kind === "offer");
			const dpa = p.documents.find((d) => d.kind === "dpa");
			expect(offer?.may_download).toBe(false);
			// The DPA is signed: a room member may save the signed copy.
			expect(dpa?.status).toBe("signed");
			expect(dpa?.may_download).toBe(true);
			expect(Object.values(p.billing).every((v) => v === null)).toBe(true);
			expect(p.tickets).toEqual([]);
			expect(p.needs_form_reference).toBeNull();
			const docIds = new Set(p.documents.map((d) => d.id));
			expect(p.tasks.length).toBeGreaterThan(0);
			expect(
				p.tasks.every(
					(t) => t.document_id !== null && docIds.has(t.document_id),
				),
			).toBe(true);
			expect(p.tasks.some((t) => t.kind === "billing_details")).toBe(false);
		});

		it("sees the answers and review notes on those tasks", async () => {
			const task = await client.call("createTask", {
				body: {
					document_id: fx.offerDetail.id,
					kind: "upload",
					title: "Stuur ons het collegebesluit",
				} as never,
				params,
			});
			await client.call("submitTask", {
				body: { response_text: "Besluit van het college" } as never,
				params: { orgId, taskId: task.id },
			});
			await client.call("reviewTask", {
				body: { decision: "send_back", note: "Graag de getekende versie" },
				params: { orgId, taskId: task.id },
			});
			as("colleague");
			const seen = (await page()).tasks.find((t) => t.id === task.id);
			expect([seen?.response_text, seen?.review_note]).toEqual([
				"Besluit van het college",
				"Graag de getekende versie",
			]);
		});

		it("reads a document as the room, with nothing to fill in", async () => {
			as("colleague");
			const d = await client.call("readDocument", {
				params: { docId: fx.offerDetail.id, orgId },
			});
			expect([d.access, d.may_download]).toEqual(["room", false]);
			expect(d.fields).toEqual([]);
			expect(d.confirmation).toBeNull();
			expect(d.prefill).toEqual({
				address: null,
				organisation: null,
				po_number: null,
			});
		});

		it("is refused invoices, billing, answers, signing and questions", async () => {
			const invoice = fx.accountPage.documents.find((d) => d.kind === "invoice")
				?.id as string;
			as("colleague");
			const attempts: Promise<unknown>[] = [
				client.call("readDocument", { params: { docId: invoice, orgId } }),
				client.call("readBilling", { params }),
				client.call("submitTask", {
					body: { response_text: "Mine" } as never,
					params: { orgId, taskId: fx.signTask.id },
				}),
				client.call("nameSigner", {
					body: {
						email: "sam@example-town.example",
						name: "Sam Example",
						role: null,
					} as never,
					params: { docId: fx.offerDetail.id, orgId },
				}),
				client.call("signDocument", {
					body: fx.signRequest,
					params: { docId: fx.offerDetail.id, orgId },
				}),
				client.call("openTicket", {
					body: { body: "Lager?", subject: "Prijs" },
					params,
				}),
			];
			for (const a of attempts)
				await expect(a).rejects.toMatchObject({ status: 403 });
		});
	});

	describe("adding someone", () => {
		it("invites someone new for an owner or admin, saying how many workspaces they reach", async () => {
			const res = await add("anna@example-town.example", "Anna Bakker", [
				"rollout",
			]);
			expect(res).toMatchObject({
				email_sent: true,
				person: {
					labels: ["rollout"],
					room: "by_invite",
					status: "invited",
				},
				status: "invited",
			});
			expect(res.workspaces_reached).toEqual(expect.any(Number));
			expect(
				(await room()).people.some(
					(p) => p.email === "anna@example-town.example",
				),
			).toBe(true);
		});

		it("refuses someone new from Billing and from a room member, with the catalog's code", async () => {
			for (const actor of ["billing", "colleague"] as const) {
				as(actor);
				await expect(
					add("anna@example-town.example", "Anna Bakker"),
				).rejects.toMatchObject(refused(403, "room.new_person_admins_only"));
			}
		});

		it("lets a room member bring in a member already, with room access and no workspace count", async () => {
			as("colleague");
			const res = await add("kim@example-town.example", "Kim Example", [
				"staff_stakeholders",
			]);
			expect(res).toMatchObject({
				email_sent: true,
				person: { room: "by_invite", status: "member" },
				status: "added",
				workspaces_reached: null,
			});
			const kim = (await room()).people.find(
				(p) => p.email === "kim@example-town.example",
			);
			expect(kim?.invited_by?.name).toBe("Sam Example");
		});

		it("only changes the labels of someone in by role, and sends nothing", async () => {
			as("billing");
			const res = await add("robin@example-town.example", "Robin Example", [
				"go_ahead",
			]);
			expect(res).toMatchObject({ email_sent: false, status: "updated" });
		});

		it("refuses a room member changing someone they did not bring in", async () => {
			as("colleague");
			await expect(
				add("noor@example-town.example", "Noor Example", ["rollout"]),
			).rejects.toMatchObject(refused(403, "room.manage_forbidden"));
		});

		it("refuses adding yourself", async () => {
			await expect(
				add("robin@example-town.example", "Robin Example"),
			).rejects.toMatchObject(refused(400, "invite.self"));
		});
	});

	describe("taking someone out", () => {
		const remove = (id: string) =>
			client.call("removeRoomPerson", {
				params: { orgId, personId: id },
			});

		it("withdraws the invitation of someone not yet joined", async () => {
			const res = await remove(personId("noor@example-town.example"));
			expect(res).toEqual({ membership: "withdrawn", status: "removed" });
			expect(
				(await room()).people.some(
					(p) => p.email === "noor@example-town.example",
				),
			).toBe(false);
		});

		it("keeps the membership of someone who joined, and takes the room away", async () => {
			const res = await remove(personId("sam@example-town.example"));
			expect(res).toEqual({ membership: "kept", status: "removed" });
			const sam = (await room()).people.find(
				(p) => p.email === "sam@example-town.example",
			);
			expect(sam?.room).toBe("none");
		});

		it("refuses a room member taking out someone they did not bring in", async () => {
			as("colleague");
			await expect(
				remove(personId("noor@example-town.example")),
			).rejects.toMatchObject(refused(403, "room.remove_forbidden"));
		});

		it("refuses taking out someone in by their role, or nobody", async () => {
			await expect(
				remove(personId("robin@example-town.example")),
			).rejects.toMatchObject(refused(409, "room.in_by_role"));
			await expect(
				remove("0199a1b8-0000-7000-8000-0000000000ff"),
			).rejects.toMatchObject(refused(404, "room.person_not_found"));
		});
	});

	describe("the labels question and the hints", () => {
		it("asks a room member once, and lets them change their labels after", async () => {
			as("colleague");
			const answer = (labels: RoomLabelT[]) =>
				client.call("answerRoomLabels", {
					body: { labels, other: null },
					params,
				});
			const me = await answer(["it_security", "privacy_ai"]);
			expect(me.labels).toEqual(["it_security", "privacy_ai"]);
			expect(me.labels_answered_at).not.toBeNull();
			expect((await room()).me?.labels_question).toBe(false);
			const later = await answer(["rollout"]);
			expect([later.labels, later.may_relabel]).toEqual([["rollout"], true]);
			expect((await room()).me?.labels_question).toBe(false);
		});

		it("lets someone nobody else brought in set their own labels, without asking", async () => {
			as("billing");
			const mine = await client.call("answerRoomLabels", {
				body: { labels: ["contract_purchasing"], other: null },
				params,
			});
			expect([mine.labels, mine.room, mine.may_relabel]).toEqual([
				["contract_purchasing"],
				"by_role",
				true,
			]);
			expect((await room()).me?.labels_question).toBe(false);
		});

		it("lets those who run the account dismiss a hint, and nobody else", async () => {
			const dismiss = () =>
				client.call("dismissRoomHint", {
					params: { label: "go_ahead", orgId },
				});
			expect((await dismiss()).dismissed_hints).toContain("go_ahead");
			// Twice is once.
			expect(
				(await dismiss()).dismissed_hints.filter((l) => l === "go_ahead"),
			).toHaveLength(1);
			as("colleague");
			await expect(dismiss()).rejects.toMatchObject({ status: 403 });
		});
	});

	describe("the invitation", () => {
		const tokenOf = async (email: string) => {
			const { roomInviteToken } = await import("./fixtureRoom");
			const p = fx.roomPage.people.find((x) => x.email === email);
			return roomInviteToken({
				access_granted_at: p?.invited_at ?? null,
				id: p?.id as string,
			}) as string;
		};
		const read = (invite: string) =>
			client.call("roomInvite", { params, query: { invite } });
		const accept = (invite: string) =>
			client.call("acceptRoomInvite", {
				body: { first_name: "Noor", invite, last_name: "Example" },
				params,
			});

		it("opens by its own token before sign-in, is accepted once by the person invited, and then says so", async () => {
			const token = await tokenOf("noor@example-town.example");
			expect(await read(token)).toMatchObject({
				inviter: { name: "Robin Example" },
				person: { email: "noor@example-town.example" },
				status: "open",
			});
			as("invitee");
			expect(await accept(token)).toEqual({ org_id: orgId });
			expect((await read(token)).status).toBe("accepted");
			as("admin");
			const noor = (await room()).people.find(
				(p) => p.email === "noor@example-town.example",
			);
			expect(noor?.status).toBe("member");
		});

		it("opens nothing for a token it did not make", async () => {
			await expect(read("not-a-token-0123456789")).rejects.toMatchObject(
				refused(404, "invite.not_found"),
			);
		});

		it("is not taken up by someone signed in under another address", async () => {
			const token = await tokenOf("noor@example-town.example");
			as("colleague");
			await expect(accept(token)).rejects.toMatchObject(
				refused(403, "invite.not_for_you"),
			);
			expect((await read(token)).status).toBe("open");
		});

		it("reads as accepted for someone who joined", async () => {
			expect(
				(await read(await tokenOf("sam@example-town.example"))).status,
			).toBe("accepted");
		});

		it("no longer opens once the person is taken out", async () => {
			const token = await tokenOf("noor@example-town.example");
			await client.call("removeRoomPerson", {
				params: { orgId, personId: personId("noor@example-town.example") },
			});
			await expect(read(token)).rejects.toMatchObject({ status: 404 });
		});
	});

	describe("the tasks summary", () => {
		const summary = async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({ orgs: [{ id: orgId, name: "Example Town" }] }),
						),
				),
			);
			try {
				return await client.call("tasksSummary");
			} finally {
				vi.unstubAllGlobals();
			}
		};

		it("lists each organisation by the caller's access to it, the second one too", async () => {
			sessionStorage.setItem("echo.accounts.fixtures.orgs", "2");
			try {
				expect((await summary()).map((o) => o.access)).toEqual([
					"account",
					"account",
				]);
				as("colleague");
				expect((await summary()).map((o) => o.access)).toEqual([
					"room",
					"room",
				]);
				as("member");
				expect(await summary()).toEqual([]);
			} finally {
				sessionStorage.removeItem("echo.accounts.fixtures.orgs");
			}
		});
	});

	describe("a room member named to sign", () => {
		it("reads and signs their document as its signer, as the server lets them", async () => {
			const offer = fx.accountPage.documents.find((d) => d.kind === "offer");
			await client.call("nameSigner", {
				body: {
					email: "sam@example-town.example",
					name: "Sam Example",
					role: null,
				},
				params: { docId: offer?.id as string, orgId },
			});
			as("colleague");
			const doc = await client.call("readDocument", {
				params: { docId: offer?.id as string, orgId },
			});
			expect(doc.access).toBe("signer");
			expect(doc.fields.length).toBeGreaterThan(0);
		});
	});
});
