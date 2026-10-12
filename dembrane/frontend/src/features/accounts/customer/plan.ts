import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";

/**
 * What the account page shows, sorted by who has the next move. Invoices to pay come
 * first and the most urgent of them on top: paying is what the page is most often opened
 * for, and an overdue invoice is the one thing that should never be missed. Then the
 * customer's open tasks, a sent-back one before the rest and a signature before the
 * smaller asks, because signing opens the steps after it. What waits on dembrane, what
 * waits on a signature, and what is done follow, each in the order staff gave them.
 */
export interface AccountPlan {
	/** Unpaid invoices, overdue first, then by due date. */
	toPay: DocumentSummaryT[];
	/** The customer's open and sent-back tasks. */
	toDo: TaskT[];
	/** Sent in, waiting on dembrane. */
	withUs: TaskT[];
	/** Waiting on a signature before they open. */
	later: TaskT[];
	done: TaskT[];
}

const unpaid = (doc: DocumentSummaryT) =>
	doc.kind === "invoice" &&
	doc.invoice != null &&
	doc.invoice.status !== "paid" &&
	doc.invoice.status !== "void";

/** Past its due date, by the invoice's own status or by the calendar. */
export const isOverdue = (doc: DocumentSummaryT, today: string): boolean =>
	doc.invoice?.status === "overdue" ||
	Boolean(doc.invoice?.due_on && doc.invoice.due_on < today);

const todoRank = (task: TaskT) =>
	task.status === "changes_requested" ? 0 : task.kind === "sign" ? 1 : 2;

export function planAccount(
	tasks: TaskT[],
	documents: DocumentSummaryT[],
	today: string,
): AccountPlan {
	const live = tasks.filter((task) => task.status !== "withdrawn");
	const isLocked = (task: TaskT) => task.locked || task.status === "locked";
	return {
		done: live.filter((task) => task.status === "done"),
		later: live.filter((task) => isLocked(task) && task.status !== "done"),
		toDo: live
			.map((task, i) => ({ i, task }))
			.filter(
				({ task }) =>
					!isLocked(task) &&
					(task.status === "open" || task.status === "changes_requested"),
			)
			.sort((a, b) => todoRank(a.task) - todoRank(b.task) || a.i - b.i)
			.map(({ task }) => task),
		toPay: documents
			.filter(unpaid)
			.sort(
				(a, b) =>
					Number(isOverdue(b, today)) - Number(isOverdue(a, today)) ||
					(a.invoice?.due_on ?? "9999").localeCompare(
						b.invoice?.due_on ?? "9999",
					),
			),
		withUs: live.filter(
			(task) => !isLocked(task) && task.status === "submitted",
		),
	};
}

/** Today as YYYY-MM-DD in the viewer's own calendar, to compare with due dates. */
export const localToday = (now = new Date()): string =>
	`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
