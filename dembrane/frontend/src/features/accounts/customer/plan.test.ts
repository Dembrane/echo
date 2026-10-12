import { describe, expect, it } from "vitest";
import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";
import { accountPage } from "../contract/fixtures.gen";
import { planAccount } from "./plan";

const base = accountPage.tasks[0] as TaskT;
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
});
