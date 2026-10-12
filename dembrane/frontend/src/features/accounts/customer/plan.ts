import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";

/**
 * What the account page shows, sorted by who has the next move. Invoices to pay come
 * first and the most urgent of them on top: paying is what the page is most often opened
 * for, and an overdue invoice is the one thing that should never be missed. Then the
 * customer's open tasks, a sent-back one before the rest and a signature before the
 * smaller asks, because signing opens the steps after it. Who signs comes before the
 * signature it is about, which waits for the answer. A signature handed to someone
 * else waits on them and leads what is coming; then what waits on dembrane, what waits on
 * a signature, and what is done, each in the order staff gave them.
 */
export interface AccountPlan {
	/** Unpaid invoices, overdue first, then by due date. */
	toPay: DocumentSummaryT[];
	/** The customer's open and sent-back tasks. */
	toDo: TaskT[];
	/** Signing tasks handed to someone else: their signature completes them. */
	waiting: { task: TaskT; signer: NonNullable<DocumentSummaryT["signer"]> }[];
	/** Sent in, waiting on dembrane. */
	withUs: TaskT[];
	/** Waiting on a signature before they open. */
	later: TaskT[];
	done: TaskT[];
	/**
	 * Offer signing tasks that also cover the DPA: while one person signs both (the same
	 * named signer, or nobody named), the DPA's task folds into the offer's and is not
	 * listed on its own. The who-signs form naming two people splits them.
	 */
	withDpa: Set<string>;
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
	task.status === "changes_requested"
		? 0
		: task.code === "who_signs"
			? 1
			: task.kind === "sign"
				? 2
				: 3;

const isOpen = (task: TaskT) =>
	task.status === "open" || task.status === "changes_requested";

/**
 * A signing task that waits until the customer says who signs: the offer's own, and the
 * DPA sent with it. Each opens with the answer.
 */
export const waitsOnWhoSigns = (task: TaskT, tasks: TaskT[]): boolean =>
	task.kind === "sign" &&
	isOpen(task) &&
	tasks.some(
		(other) =>
			other.code === "who_signs" &&
			isOpen(other) &&
			(other.document_id === task.document_id || task.code === "sign_dpa"),
	);

export function planAccount(
	tasks: TaskT[],
	documents: DocumentSummaryT[],
	today: string,
	/** The viewer's email: a document named to them is still theirs to sign. */
	me: string | null = null,
): AccountPlan {
	const isLocked = (task: TaskT) =>
		task.locked || task.status === "locked" || waitsOnWhoSigns(task, tasks);
	const signerOf = (task: TaskT) => {
		if (task.kind !== "sign" || !task.document_id || isLocked(task))
			return null;
		if (task.status !== "open" && task.status !== "changes_requested")
			return null;
		const signer = documents.find((d) => d.id === task.document_id)?.signer;
		if (!signer) return null;
		return me && signer.email.toLowerCase() === me.toLowerCase()
			? null
			: signer;
	};
	const waiting: AccountPlan["waiting"] = [];
	const live = tasks.filter((task) => {
		if (task.status === "withdrawn") return false;
		const signer = signerOf(task);
		if (signer) waiting.push({ signer, task });
		return !signer;
	});
	const plan: AccountPlan = {
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
		waiting,
		withDpa: new Set(),
		withUs: live.filter(
			(task) => !isLocked(task) && task.status === "submitted",
		),
	};
	foldDpa(plan, documents);
	return plan;
}

/** Folds each DPA signature into an offer signature in the same place with the same signer. */
function foldDpa(plan: AccountPlan, documents: DocumentSummaryT[]) {
	const signer = (task: TaskT) =>
		documents
			.find((d) => d.id === task.document_id)
			?.signer?.email.toLowerCase() ?? null;
	const fold = (list: TaskT[]): TaskT[] =>
		list.filter((dpa) => {
			if (dpa.code !== "sign_dpa") return true;
			const offer = list.find(
				(o) =>
					o.code === "sign_offer" &&
					!plan.withDpa.has(o.id) &&
					signer(o) === signer(dpa),
			);
			if (!offer) return true;
			plan.withDpa.add(offer.id);
			return false;
		});
	plan.toDo = fold(plan.toDo);
	plan.later = fold(plan.later);
	const kept = new Set(fold(plan.waiting.map((w) => w.task)).map((t) => t.id));
	plan.waiting = plan.waiting.filter((w) => kept.has(w.task.id));
}

/** Steps that help a new customer start, never required: they sit under To do on their own. */
export const GET_STARTED: NonNullable<TaskT["code"]>[] = [
	"explore_demo",
	"watch_tutorial",
	"create_project",
	"book_call",
];

export const isGetStarted = (task: TaskT) =>
	task.code != null && GET_STARTED.includes(task.code);

export type ToDoItem =
	| { kind: "invoice"; id: string; doc: DocumentSummaryT }
	| { kind: "task"; id: string; task: TaskT };

/**
 * What is the customer's to do, the next one first: it alone gets the blue pill. Next is
 * the most overdue, else the nearest deadline (an invoice's due date, a task's due date,
 * an offer's valid-until); on a tie, or with no deadline, a sent-back task, then who
 * signs, then a signature, then the rest, each in the order they came.
 */
export function toDoInOrder(
	plan: Pick<AccountPlan, "toPay" | "toDo">,
	documents: DocumentSummaryT[],
): ToDoItem[] {
	const deadline = (item: ToDoItem): string | null => {
		if (item.kind === "invoice") return item.doc.invoice?.due_on ?? null;
		const { task } = item;
		if (task.due_on) return task.due_on;
		if (task.kind !== "sign") return null;
		return (
			documents.find((d) => d.id === task.document_id)?.valid_until ?? null
		);
	};
	const rank = (item: ToDoItem) =>
		item.kind === "invoice" ? 3 : todoRank(item.task);
	const items: ToDoItem[] = [
		...plan.toPay.map((doc) => ({ doc, id: doc.id, kind: "invoice" as const })),
		...plan.toDo
			.filter((task) => !isGetStarted(task))
			.map((task) => ({ id: task.id, kind: "task" as const, task })),
	];
	return items
		.map((item, i) => ({ d: deadline(item), i, item }))
		.sort(
			(a, b) =>
				(a.d ?? "9999").localeCompare(b.d ?? "9999") ||
				rank(a.item) - rank(b.item) ||
				a.i - b.i,
		)
		.map(({ item }) => item);
}

/** Today as YYYY-MM-DD in the viewer's own calendar, to compare with due dates. */
export const localToday = (now = new Date()): string =>
	`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
