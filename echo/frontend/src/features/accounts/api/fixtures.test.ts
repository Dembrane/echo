// @vitest-environment jsdom
import { PDFDocument } from "pdf-lib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as contract from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

/**
 * Fixture mode stands in for the backend until its handlers land, so its answers must be
 * what the contract says the API returns: the static fixtures parse, and the in-page
 * backend keeps parsing through every flow the screens drive.
 */

describe("the demo fixtures parse against the contract", () => {
	const cases: [string, unknown, { parse: (v: unknown) => unknown }][] = [
		["accountPage", fx.accountPage, contract.AccountPage],
		["offerDetail", fx.offerDetail, contract.DocumentDetail],
		["signedDpaDetail", fx.signedDpaDetail, contract.DocumentDetail],
		["signRequest", fx.signRequest, contract.SignRequest],
		["signResponse", fx.signResponse, contract.SignResponse],
		["signingRequests", fx.signingRequests, contract.SigningRequests],
		["accountList", fx.accountList, contract.AccountList],
		["accountCard", fx.accountCard, contract.AccountCard],
		["pushOfferRequest", fx.pushOfferRequest, contract.PushOfferRequest],
		["pushOfferResponse", fx.pushOfferResponse, contract.PushOfferResponse],
		[
			"createAccountResponse",
			fx.createAccountResponse,
			contract.CreateAccountResponse,
		],
		["offerFieldsResponse", fx.offerFieldsResponse, contract.DocumentFields],
	];
	it.each(cases)("%s", (_, value, schema) => {
		expect(() => schema.parse(value)).not.toThrow();
	});
});

describe("the fixture backend, through the client", () => {
	let client: typeof import("./client");
	let backend: typeof import("./fixtureBackend");
	const org = fx.accountPage.organisation.id;

	beforeAll(async () => {
		vi.stubEnv("VITE_ACCOUNTS_FIXTURES", "1");
		client = await import("./client");
		backend = await import("./fixtureBackend");
		expect(client.FIXTURE_MODE).toBe(true);
	});
	beforeEach(() => backend.resetFixtures());

	it("serves the account page with the billing task locked", async () => {
		const page = await client.call("accountPage", { params: { orgId: org } });
		const billing = page.tasks.find((t) => t.kind === "billing_details");
		expect(billing?.locked).toBe(true);
		expect(page.tasks[0]?.status).toBe("open");
		expect(page.documents.map((d) => d.kind)).toEqual([
			"offer",
			"invoice",
			"dpa",
		]);
	});

	it("signing the offer completes its task and opens billing", async () => {
		const offer = await client.call("readDocument", {
			params: { docId: fx.offerDetail.id, orgId: org },
		});
		const result = await client.call("signDocument", {
			body: fx.signRequest,
			params: { docId: offer.id, orgId: org },
		});
		expect(result.confirmation_text).toBe(fx.signRequest.confirmation_text);
		const page = await client.call("accountPage", { params: { orgId: org } });
		expect(page.tasks.find((t) => t.kind === "sign")?.status).toBe("done");
		const billing = page.tasks.find((t) => t.kind === "billing_details");
		expect(billing?.locked).toBe(false);
		expect(billing?.status).toBe("open");
		const signedOffer = await client.call("readDocument", {
			params: { docId: offer.id, orgId: org },
		});
		expect(signedOffer.status).toBe("signed");
		expect(signedOffer.signed_pdf_url).toMatch(/signed\.pdf$/);
	});

	it("refuses a confirmation that does not match the document", async () => {
		await expect(
			client.call("signDocument", {
				body: { ...fx.signRequest, confirmation_text: "I sign something else" },
				params: { docId: fx.offerDetail.id, orgId: org },
			}),
		).rejects.toMatchObject({ status: 422 });
	});

	it("validates a request before it leaves", async () => {
		await expect(
			client.call("openTicket", {
				body: { body: "", subject: "Hi" },
				params: { orgId: org },
			}),
		).rejects.toMatchObject({
			fields: { body: expect.any(String) },
			status: 422,
		});
	});

	it("adds a question and a reply", async () => {
		const ticket = await client.call("openTicket", {
			body: { body: "Kan de factuur op ons PO?", subject: "PO-nummer" },
			params: { orgId: org },
		});
		expect(ticket.status).toBe("waiting_on_dembrane");
		const answered = await client.call("staffReplyTicket", {
			body: { body: "Ja.", close: false },
			params: { orgId: org, ticketId: ticket.id },
		});
		expect(answered.status).toBe("waiting_on_customer");
		expect(answered.messages).toHaveLength(2);
	});

	it("pushes an offer the customer then sees", async () => {
		const res = await client.call("pushOffer", {
			body: fx.pushOfferRequest,
			params: { orgId: org },
		});
		expect(res.document.total_cents).toBe(775610);
		expect(res.document.fields.some((f) => f.kind === "signature")).toBe(true);
		const page = await client.call("accountPage", { params: { orgId: org } });
		expect(page.documents[0]?.id).toBe(res.document.id);
	});

	it("uploads a PDF as a draft, takes fields and sends it", async () => {
		const pdf = await PDFDocument.create();
		pdf.addPage();
		pdf.addPage();
		const b64 = btoa(String.fromCharCode(...(await pdf.save())));
		const pushed = await client.call("pushDocument", {
			body: {
				kind: "other",
				pdf_base64: b64,
				requires_signature: true,
				send: false,
				task: { body: null, title: "Teken de inkooporder" },
				title: "Inkooporder",
			},
			params: { orgId: org },
		});
		expect(pushed.document.status).toBe("draft");
		expect(pushed.document.page_count).toBe(2);
		const docId = pushed.document.id;
		await expect(
			client.call("sendDocument", { params: { docId, orgId: org } }),
		).rejects.toMatchObject({
			status: 422,
		});
		const signatureOnly = {
			height: 0.06,
			kind: "signature" as const,
			label: "Handtekening",
			page: 2,
			width: 0.3,
			x: 0.1,
			y: 0.8,
		};
		await client.call("setDocumentFields", {
			body: { fields: [signatureOnly] },
			params: { docId, orgId: org },
		});
		// A document to sign needs a name field as well as a signature field.
		await expect(
			client.call("sendDocument", { params: { docId, orgId: org } }),
		).rejects.toMatchObject({ status: 422 });
		const set = await client.call("setDocumentFields", {
			body: {
				fields: [
					{
						height: 0.06,
						kind: "signature",
						label: "Handtekening",
						page: 2,
						width: 0.3,
						x: 0.1,
						y: 0.8,
					},
					{
						height: 0.025,
						kind: "name",
						label: "Naam",
						page: 2,
						width: 0.4,
						x: 0.1,
						y: 0.7,
					},
				],
			},
			params: { docId, orgId: org },
		});
		expect(set.fields.map((f) => f.kind)).toEqual(["name", "signature"]);
		const sent = await client.call("sendDocument", {
			params: { docId, orgId: org },
		});
		expect(sent.status).toBe("sent");
		// No role field and no organisation field: {role} is left out and the
		// organisation's own name is written in, as the server builds it.
		const template = sent.confirmation?.dpa_authorised ?? "";
		expect(template).toContain("{name}");
		expect(template).not.toContain("{role}");
		expect(template).toContain("Gemeente Voorbeeldstad");
		const card = await client.call("accountCard", { params: { orgId: org } });
		// The task given with the draft is created on send.
		expect(
			card.tasks.some(
				(t) =>
					t.document_id === docId &&
					t.kind === "sign" &&
					t.title === "Teken de inkooporder",
			),
		).toBe(true);
	});

	it("reviews a submitted task", async () => {
		const card = await client.call("accountCard", { params: { orgId: org } });
		const submitted = card.tasks.find((t) => t.status === "submitted");
		if (!submitted) throw new Error("the demo has a submitted task");
		await expect(
			client.call("reviewTask", {
				body: { decision: "send_back", note: null },
				params: { orgId: org, taskId: submitted.id },
			}),
		).rejects.toMatchObject({ status: 422 });
		const approved = await client.call("reviewTask", {
			body: { decision: "approve", note: null },
			params: { orgId: org, taskId: submitted.id },
		});
		expect(approved.status).toBe("done");
	});
});
