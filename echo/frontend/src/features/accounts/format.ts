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
 * A task's title and body in the viewer's language. The tasks the system makes (signing
 * and billing details) are rendered from these strings whatever was stored; only tasks
 * staff wrote by hand show their stored text.
 */
export const taskText = (
	task: TaskT,
	documents: DocumentSummaryT[],
): { title: string; body: string | null } => {
	if (task.kind === "billing_details") {
		return {
			body: t`Who we invoice: legal name, address, VAT or KvK number, invoice email and, if you use one, a PO number.`,
			title: t`Billing details`,
		};
	}
	if (task.kind === "sign") {
		const doc = documents.find((d) => d.id === task.document_id);
		if (!doc || doc.kind === "offer") {
			return {
				body: t`Read the offer and sign it here. Someone else signs for your organisation? Name them on the offer; they get their own link.`,
				title: t`Review and sign the offer`,
			};
		}
		if (doc.kind === "dpa") {
			return {
				body: t`Someone who may agree to data processing for your organisation signs the data processing agreement.`,
				title: t`Sign the data processing agreement`,
			};
		}
		return { body: null, title: t`Sign ${doc.title}` };
	}
	return { body: task.body, title: task.title };
};

/** A document's title in the viewer's language where it is made by the system. */
export const documentTitle = (doc: DocumentSummaryT): string =>
	doc.kind === "invoice" && doc.invoice?.number
		? t`Invoice ${doc.invoice.number}`
		: doc.title;
