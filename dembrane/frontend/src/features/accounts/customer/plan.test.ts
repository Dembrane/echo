import { describe, expect, it } from "vitest";
import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";
import { accountPage } from "../contract/fixtures.gen";
import { planAccount, toDoInOrder } from "./plan";

const base = accountPage.tasks.find((t) => t.code === "sign_offer") as TaskT;
const task = (id: string, over: Partial<TaskT>): TaskT => ({
	...base,
	id,
	locked: false,
	...over,
});
const invoiceDoc = accountPage.documents.find(
	(d) => d.kind === "invoice",
) as DocumentSummaryT;
const invoice = (
	id: string,
	over: Partial<NonNullable<DocumentSummaryT["invoice"]>>,
): DocumentSummaryT => ({
	...invoiceDoc,
	id,
	invoice: {
		...(invoiceDoc.invoice as NonNullable<DocumentSummaryT["invoice"]>),
		...over,
	},
});

describe("planAccount", () => {
	it("puts a sent-back task, then a signature, before other open tasks", () => {
		const plan = planAccount(
			[
				task("a", { kind: "generic", status: "open" }),
				task("b", { kind: "sign", status: "open" }),
				task("c", { kind: "upload", status: "changes_requested" }),
			],
			[],
			"2026-10-12",
		);
		expect(plan.toDo.map((t) => t.id)).toEqual(["c", "b", "a"]);
	});

	it("asks who signs first, and keeps the offer's signature, with the DPA's, for after", () => {
		const plan = planAccount(
			[
				task("a", { code: null, kind: "generic", status: "open" }),
				task("offer", { document_id: "o", kind: "sign", status: "open" }),
				task("dpa", {
					code: "sign_dpa",
					document_id: "p",
					kind: "sign",
					status: "open",
				}),
				task("who", {
					code: "who_signs",
					document_id: "o",
					kind: "generic",
					status: "open",
				}),
			],
			[],
			"2026-10-12",
		);
		expect(plan.toDo.map((t) => t.id)).toEqual(["who", "a"]);
		expect(plan.later.map((t) => t.id)).toEqual(["offer"]);
		expect(plan.withDpa).toEqual(new Set(["offer"]));
		// Answered: both open.
		const answered = planAccount(
			[
				task("offer", { document_id: "o", kind: "sign", status: "open" }),
				task("who", {
					code: "who_signs",
					document_id: "o",
					kind: "generic",
					status: "done",
				}),
			],
			[],
			"2026-10-12",
		);
		expect(answered.toDo.map((t) => t.id)).toEqual(["offer"]);
	});

	it("sorts tasks into with us, later and done, and drops withdrawn ones", () => {
		const plan = planAccount(
			[
				task("s", { status: "submitted" }),
				task("l", { locked: true, status: "open" }),
				task("d", { status: "done" }),
				task("w", { status: "withdrawn" }),
			],
			[],
			"2026-10-12",
		);
		expect(plan.toDo).toEqual([]);
		expect(plan.withUs.map((t) => t.id)).toEqual(["s"]);
		expect(plan.later.map((t) => t.id)).toEqual(["l"]);
		expect(plan.done.map((t) => t.id)).toEqual(["d"]);
	});

	it("lists unpaid invoices, overdue first, then by due date", () => {
		const plan = planAccount(
			[],
			[
				invoice("later", { due_on: "2026-11-30", status: "open" }),
				invoice("soon", { due_on: "2026-10-20", status: "open" }),
				invoice("paid", { due_on: "2026-09-01", status: "paid" }),
				invoice("late", { due_on: "2026-10-01", status: "open" }),
			],
			"2026-10-12",
		);
		expect(plan.toPay.map((d) => d.id)).toEqual(["late", "soon", "later"]);
	});

	it("hands a signature named to someone else to them, unless the viewer is that person", () => {
		const offer = {
			...invoiceDoc,
			id: "doc",
			invoice: undefined,
			kind: "offer",
			signer: {
				email: "Taylor@Lake.example",
				name: "Taylor Lake",
				named_at: null,
				reminded_at: null,
				role: null,
			},
		} as DocumentSummaryT;
		const tasks = [
			task("sign", { document_id: "doc", kind: "sign", status: "open" }),
			task("other", { kind: "generic", status: "open" }),
		];
		const plan = planAccount(tasks, [offer], "2026-10-12", "me@x.example");
		expect(plan.toDo.map((t) => t.id)).toEqual(["other"]);
		expect(plan.waiting.map((w) => [w.task.id, w.signer.name])).toEqual([
			["sign", "Taylor Lake"],
		]);
		const theirs = planAccount(
			tasks,
			[offer],
			"2026-10-12",
			"taylor@lake.example",
		);
		expect(theirs.toDo.map((t) => t.id)).toEqual(["sign", "other"]);
		expect(theirs.waiting).toEqual([]);
	});

	it("lists the DPA with the offer while one person signs both, and apart once the form names two", () => {
		const doc = (id: string, email: string | null): DocumentSummaryT => ({
			...invoiceDoc,
			id,
			invoice: undefined,
			kind: id === "p" ? "dpa" : "offer",
			signer: email
				? { email, name: email, named_at: null, reminded_at: null, role: null }
				: null,
		});
		const tasks = [
			task("offer", { document_id: "o", kind: "sign", status: "open" }),
			task("dpa", {
				code: "sign_dpa",
				document_id: "p",
				kind: "sign",
				status: "open",
			}),
		];
		const one = planAccount(
			tasks,
			[doc("o", null), doc("p", null)],
			"2026-10-12",
		);
		expect(one.toDo.map((t) => t.id)).toEqual(["offer"]);
		expect(one.withDpa.has("offer")).toBe(true);
		const same = planAccount(
			tasks,
			[doc("o", "taylor@x.example"), doc("p", "Taylor@x.example")],
			"2026-10-12",
			"me@x.example",
		);
		expect(same.waiting.map((w) => w.task.id)).toEqual(["offer"]);
		expect(same.withDpa.has("offer")).toBe(true);
		const two = planAccount(
			tasks,
			[doc("o", "taylor@x.example"), doc("p", "dpo@x.example")],
			"2026-10-12",
			"me@x.example",
		);
		expect(two.waiting.map((w) => w.task.id)).toEqual(["offer", "dpa"]);
		expect(two.withDpa.size).toBe(0);
	});

	it("puts the next task first: most overdue, else the nearest deadline, sent-back on a tie", () => {
		const plan = planAccount(
			[
				task("reply", { code: null, kind: "generic", status: "open" }),
				task("back", {
					code: null,
					due_on: "2026-10-20",
					kind: "upload",
					status: "changes_requested",
				}),
				task("po", {
					code: null,
					due_on: "2026-10-20",
					kind: "generic",
					status: "open",
				}),
				task("demo", { code: "explore_demo", kind: "generic", status: "open" }),
			],
			[invoice("late", { due_on: "2026-10-01", status: "open" })],
			"2026-10-12",
		);
		expect(toDoInOrder(plan, []).map((x) => x.id)).toEqual([
			"late",
			"back",
			"po",
			"reply",
		]);
	});
});
