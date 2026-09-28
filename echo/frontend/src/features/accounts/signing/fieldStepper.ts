import type { DocumentDetailT, DocumentFieldT } from "../contract/contract.gen";

/**
 * The walk through a document's fields: which field comes next, what counts as filled,
 * how far along the signer is, and the confirmation sentence built from their answers.
 * Pure, so the signing screen stays a view over it and the rules are tested on their own.
 */

export type FieldValue = string | boolean;
export type Values = Record<string, FieldValue>;

export interface Images {
	signature: boolean;
	initials: boolean;
}

/** Walk order: the server's sort, then top to bottom, page by page. */
export const orderFields = (
	fields: readonly DocumentFieldT[],
): DocumentFieldT[] =>
	[...fields].sort(
		(a, b) => a.sort - b.sort || a.page - b.page || a.y - b.y || a.x - b.x,
	);

export const isFilled = (
	field: DocumentFieldT,
	values: Values,
	images: Images,
): boolean => {
	if (field.kind === "signature") return images.signature;
	// Initials fall back to the signature image, as the sign request does.
	if (field.kind === "initials") return images.initials || images.signature;
	const v = values[field.id];
	if (field.kind === "checkbox") return v === true;
	return typeof v === "string" && v.trim().length > 0;
};

/**
 * The next required field that is still empty, looking forward from `currentId` and
 * wrapping to the start; null when every required field is filled.
 */
export const nextRequired = (
	fields: readonly DocumentFieldT[],
	values: Values,
	images: Images,
	currentId: string | null = null,
): DocumentFieldT | null => {
	const ordered = orderFields(fields);
	const start = currentId
		? ordered.findIndex((f) => f.id === currentId) + 1
		: 0;
	for (let i = 0; i < ordered.length; i++) {
		const f = ordered[(start + i) % ordered.length] as DocumentFieldT;
		if (f.required && !isFilled(f, values, images)) return f;
	}
	return null;
};

/**
 * Where "Next" goes: the next field after `currentId` (wrapping) that the signer has not
 * seen yet, so the first pass shows every field once, prefilled ones included, to check;
 * after that only required fields still empty. Null when nothing is left: time to sign.
 */
export const nextStop = (
	fields: readonly DocumentFieldT[],
	values: Values,
	images: Images,
	currentId: string | null,
	visited: ReadonlySet<string>,
): DocumentFieldT | null => {
	const ordered = orderFields(fields);
	const start = currentId
		? ordered.findIndex((f) => f.id === currentId) + 1
		: 0;
	for (let i = 0; i < ordered.length; i++) {
		const f = ordered[(start + i) % ordered.length] as DocumentFieldT;
		if (f.id === currentId) continue;
		if (!visited.has(f.id)) return f;
		if (f.required && !isFilled(f, values, images)) return f;
	}
	return null;
};

/** The field after `currentId` in walk order, required or not; null at the end. */
export const nextField = (
	fields: readonly DocumentFieldT[],
	currentId: string | null,
): DocumentFieldT | null => {
	const ordered = orderFields(fields);
	const i = currentId ? ordered.findIndex((f) => f.id === currentId) : -1;
	return ordered[i + 1] ?? null;
};

export const previousField = (
	fields: readonly DocumentFieldT[],
	currentId: string | null,
): DocumentFieldT | null => {
	const ordered = orderFields(fields);
	const i = currentId
		? ordered.findIndex((f) => f.id === currentId)
		: ordered.length;
	return i > 0 ? (ordered[i - 1] ?? null) : null;
};

export const progress = (
	fields: readonly DocumentFieldT[],
	values: Values,
	images: Images,
): { done: number; total: number } => {
	const required = fields.filter((f) => f.required);
	return {
		done: required.filter((f) => isFilled(f, values, images)).length,
		total: required.length,
	};
};

export const isComplete = (
	fields: readonly DocumentFieldT[],
	values: Values,
	images: Images,
): boolean => nextRequired(fields, values, images) === null;

const answerOf = (
	fields: readonly DocumentFieldT[],
	values: Values,
	match: (f: DocumentFieldT) => boolean,
): string => {
	const f = fields.find(match);
	const v = f ? values[f.id] : undefined;
	return typeof v === "string" ? v.trim() : "";
};

/**
 * The sentence the signer confirms, with {name}, {role} and {organisation} filled from the
 * name and role fields and the `organisation` text field, exactly as the server builds it.
 */
export const fillConfirmation = (
	template: string,
	fields: readonly DocumentFieldT[],
	values: Values,
): string =>
	template
		.split("{name}")
		.join(answerOf(fields, values, (f) => f.kind === "name"))
		.split("{role}")
		.join(answerOf(fields, values, (f) => f.kind === "role"))
		.split("{organisation}")
		.join(
			answerOf(
				fields,
				values,
				(f) => f.kind === "text" && f.key === "organisation",
			),
		);

/** The confirmation template for the signer's answer to the data processing question. */
export const confirmationTemplate = (
	doc: Pick<DocumentDetailT, "confirmation">,
	dpaAuthorised: boolean,
): string | null => {
	if (!doc.confirmation) return null;
	if (!dpaAuthorised && doc.confirmation.dpa_not_authorised) {
		return doc.confirmation.dpa_not_authorised;
	}
	return doc.confirmation.dpa_authorised;
};

/** Offers ask whether the signer may also agree to data processing; other documents do not. */
export const asksDpaQuestion = (
	doc: Pick<DocumentDetailT, "kind" | "confirmation">,
): boolean =>
	doc.kind === "offer" && Boolean(doc.confirmation?.dpa_not_authorised);

/** The sign request's `values`: every non-image field, checkboxes as booleans. */
export const requestValues = (
	fields: readonly DocumentFieldT[],
	values: Values,
): Record<string, FieldValue> => {
	const out: Record<string, FieldValue> = {};
	for (const f of fields) {
		if (f.kind === "signature" || f.kind === "initials") continue;
		const v = values[f.id];
		if (f.kind === "checkbox") out[f.id] = v === true;
		else if (typeof v === "string" && v.trim()) out[f.id] = v.trim();
	}
	return out;
};

/** Dates on documents read day-month-year, as the templates print them. */
export const todayForDocument = (date = new Date()): string =>
	`${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
