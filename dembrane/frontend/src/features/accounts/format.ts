import { t } from "@lingui/core/macro";
import type { DocumentSummaryT, TaskT, TicketT } from "./contract/contract.gen";

/** Labels and formats shared by the customer and staff screens. Call during render. */

export const formatMoney = (
	cents: number | null | undefined,
	currency: string | null | undefined,
	locale: string,
): string => {
	if (cents == null) return "";
	return new Intl.NumberFormat(locale, {
		currency: currency ?? "EUR",
		style: "currency",
	}).format(cents / 100);
};

export const formatDate = (
	iso: string | null | undefined,
	locale: string,
): string => {
	if (!iso) return "";
	const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
	if (Number.isNaN(d.getTime())) return "";
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
};

export const formatDateTime = (
	iso: string | null | undefined,
	locale: string,
): string => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(d);
};

export const documentKindLabel = (kind: DocumentSummaryT["kind"]): string =>
	({
		dpa: t`DPA`,
		invoice: t`Invoice`,
		offer: t`Offer`,
		other: t`Document`,
	})[kind];

/** What the customer needs to know about a document, in one or two words. */
export const documentStatusLabel = (doc: DocumentSummaryT): string => {
	if (doc.kind === "invoice" && doc.invoice?.status) {
		return {
			open: t`To pay`,
			overdue: t`Overdue`,
			paid: t`Paid`,
			void: t`Cancelled`,
		}[doc.invoice.status];
	}
	return {
		declined: t`Declined`,
		draft: t`Draft`,
		sent: doc.requires_signature ? t`To sign` : t`Sent`,
		signed: t`Signed`,
		viewed: doc.requires_signature ? t`To sign` : t`Viewed`,
		void: t`Withdrawn`,
	}[doc.status];
};

export const documentStatusColor = (doc: DocumentSummaryT): string => {
	if (doc.kind === "invoice") {
		if (doc.invoice?.status === "overdue") return "red";
		if (doc.invoice?.status === "paid") return "green";
		return "blue";
	}
	if (doc.status === "signed") return "green";
	if (doc.status === "declined" || doc.status === "void") return "gray";
	if (
		doc.requires_signature &&
		(doc.status === "sent" || doc.status === "viewed")
	)
		return "blue";
	return "gray";
};

export const taskStatusLabel = (status: TaskT["status"]): string =>
	({
		changes_requested: t`Sent back`,
		done: t`Done`,
		locked: t`Locked`,
		open: t`Open`,
		submitted: t`Waiting on dembrane`,
		withdrawn: t`Withdrawn`,
	})[status];

export const ticketStatusLabel = (status: TicketT["status"]): string =>
	({
		closed: t`Closed`,
		open: t`Open`,
		waiting_on_customer: t`Answered`,
		waiting_on_dembrane: t`Waiting on dembrane`,
	})[status];

export const stageLabel = (stage: string | null): string =>
	stage === "prospect"
		? t`Prospect`
		: stage === "customer"
			? t`Customer`
			: stage === "churned"
				? t`Churned`
				: t`No account`;

/**
 * The words for a task echo made itself, from its code, in the viewer's language. Such
 * tasks carry a code and params and no text; `params.document_title` names the document.
 */
export const codedTaskText = (
	code: NonNullable<TaskT["code"]>,
	params: Record<string, string> | null,
): { title: string; body: string } => {
	const doc = params?.document_title ?? "";
	switch (code) {
		case "sign_offer":
			return {
				body: t`Read the offer and sign it here. Someone else signs for your organisation? Name them on the offer; they get their own link.`,
				title: doc ? t`Review and sign ${doc}` : t`Review and sign the offer`,
			};
		case "sign_dpa":
			return {
				body: t`Someone who may agree to data processing for your organisation signs it.`,
				title: doc ? t`Sign ${doc}` : t`Sign the data processing agreement`,
			};
		case "billing_details":
			return {
				body: t`Who we invoice: legal name, address, VAT or KvK number, invoice email and, if you use one, a PO number.`,
				title: t`Billing details`,
			};
		case "explore_demo":
			return {
				body: t`See popcorn, tensions and the map on sample conversations written for your organisation.`,
				title: t`Explore your demo`,
			};
		case "record_first_conversation":
			return {
				body: t`Start a project of your own and record a few minutes, with a colleague or on your own.`,
				title: t`Record a test conversation`,
			};
		case "invite_colleague":
			return {
				body: t`Bring in someone who would run a session with you.`,
				title: t`Invite a colleague`,
			};
		case "book_call":
			return {
				body: t`We walk through your demo with you and plan a first session.`,
				title: t`Book a call with us`,
			};
	}
};

/** A task's title and body: worded from its code when echo made it, else as staff wrote it. */
export const taskText = (
	task: TaskT,
): { title: string; body: string | null } =>
	task.code
		? codedTaskText(task.code, task.params)
		: { body: task.body, title: task.title ?? "" };

/** The next task line of a tasks-summary row, worded the same way. */
export const nextTaskText = (row: {
	next_task_title: string | null;
	next_task_code: TaskT["code"];
	next_task_params: Record<string, string> | null;
}): string | null =>
	row.next_task_code
		? codedTaskText(row.next_task_code, row.next_task_params).title
		: row.next_task_title;

/** A document's title in the viewer's language where it is made by the system. */
export const documentTitle = (doc: DocumentSummaryT): string =>
	doc.kind === "invoice" && doc.invoice?.number
		? t`Invoice ${doc.invoice.number}`
		: doc.title;
