import type { AnalysisRevision } from "@/components/analysis/hooks";

/** The kinds a finding can take. Anything else renders as its label alone. */
export type ResultKind =
	| "popcorn"
	| "tension"
	| "stakeholder"
	| "argument"
	| "deduplicated_argument";

export type ResultEvidence = {
	quotes: number;
	conversations: number;
};

/**
 * What a revision says it changed. The server is growing a `change_kind`
 * field; old and generated revisions have none and read as "not recorded".
 */
export type ChangeKind =
	| "typo"
	| "clarity"
	| "meaning"
	| "withdraw"
	| "restore"
	| "rollback";

const CHANGE_KINDS: ChangeKind[] = [
	"typo",
	"clarity",
	"meaning",
	"withdraw",
	"restore",
	"rollback",
];

const KINDS: ResultKind[] = [
	"popcorn",
	"tension",
	"stakeholder",
	"argument",
	"deduplicated_argument",
];

export const isResultKind = (type: string): type is ResultKind =>
	(KINDS as string[]).includes(type);

/**
 * The fields a host may reword. The server keeps the real allowlist; this one
 * decides what the screen offers, and the two are meant to read the same.
 */
export type EditableField =
	| "phrase"
	| "poleA"
	| "poleB"
	| "knot"
	| "toResolve"
	| "name"
	| "role"
	| "stake"
	| "statement";

const FIELDS_BY_KIND: Record<string, EditableField[]> = {
	argument: ["statement"],
	deduplicated_argument: ["statement"],
	popcorn: ["phrase"],
	stakeholder: ["name", "role", "stake"],
	tension: ["poleA", "poleB", "knot", "toResolve"],
};

/** Every field of this kind a host may reword, in the order they read. */
export const editableFields = (type: string): EditableField[] =>
	FIELDS_BY_KIND[type] ?? [];

/** The fields the first line of a row is made of. A tension has two. */
export const primaryFields = (type: string): EditableField[] =>
	type === "tension" ? ["poleA", "poleB"] : editableFields(type).slice(0, 1);

/** Where a sentence is expected, Enter makes a line and Cmd/Ctrl+Enter commits. */
const MULTILINE = new Set<EditableField>([
	"knot",
	"toResolve",
	"stake",
	"statement",
]);

export const isMultiline = (field: EditableField): boolean =>
	MULTILINE.has(field);

type Bag = Record<string, unknown>;

const bag = (value: unknown): Bag =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Bag)
		: {};

const text = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

/**
 * The words a finding is made of. `payload` is the truth where the reader has
 * it; the map's sanitized payload carries `detail` instead, under the same
 * field names.
 */
export function resultFields(item: {
	payload?: Bag | null;
	detail?: unknown;
}): Bag {
	return { ...bag(item.detail), ...bag(item.payload) };
}

/** The line a room reads first: the one that sets the type size. */
export function primaryText(type: string, fields: Bag, fallback = ""): string {
	if (type === "popcorn") return text(fields.phrase) || fallback;
	if (type === "stakeholder") return text(fields.name) || fallback;
	if (type === "tension")
		return (
			[text(fields.poleA), text(fields.poleB)].filter(Boolean).join(" ") ||
			text(fields.knot) ||
			fallback
		);
	return text(fields.statement) || fallback;
}

/**
 * Three steps, never a truncation: a short finding is read across the room, a
 * long one settles into reading type rather than losing its tail. The
 * thresholds are the deck's own (`sizeOf` in the popcorn `app.js`), so a
 * finding steps down here where it would on a slide. `columns` is how many
 * share the measure: a tension's pole has half of it.
 */
export function sizeStep(value: string, columns = 1): 1 | 2 | 3 {
	const length = value.length * columns;
	if (length <= 60) return 1;
	if (length <= 120) return 2;
	return 3;
}

type EvidenceGroupish = { conversationId?: unknown; quotes?: unknown };

/** The stage shows at most three quotes, each clamped to three lines. */
export const QUOTE_LIMIT = 3;

function groups(item: { detail?: unknown }): EvidenceGroupish[] {
	const detail = bag(item.detail);
	return Array.isArray(detail.evidence)
		? (detail.evidence as EvidenceGroupish[])
		: [];
}

function sourceRefs(item: { provenance?: Bag | null }): Bag[] {
	const refs = bag(item.provenance).sourceRefs;
	return Array.isArray(refs) ? (refs as Bag[]) : [];
}

/** Every quote the object carries, in the order it carries them. */
export function resultQuotes(item: {
	detail?: unknown;
	provenance?: Bag | null;
}): string[] {
	const fromGroups = groups(item).flatMap((group) =>
		Array.isArray(group.quotes) ? group.quotes.map(text) : [],
	);
	if (fromGroups.some(Boolean)) return fromGroups.filter(Boolean);
	return sourceRefs(item)
		.map((ref) => text(ref.quote))
		.filter(Boolean);
}

/**
 * The evidence count, from what this object carries and nothing else. A
 * payload that withholds its quotes counts the conversations it names.
 */
export function resultEvidence(item: {
	detail?: unknown;
	provenance?: Bag | null;
}): ResultEvidence {
	const conversations = new Set<string>();
	let quotes = 0;
	for (const group of groups(item)) {
		const id = text(group.conversationId);
		if (id) conversations.add(id);
		if (Array.isArray(group.quotes))
			quotes += group.quotes.filter((quote) => text(quote)).length;
	}
	for (const ref of sourceRefs(item)) {
		const id = text(ref.conversationId);
		if (id) conversations.add(id);
		if (text(ref.quote) && groups(item).length === 0) quotes += 1;
	}
	return { conversations: conversations.size, quotes };
}

/** What a revision says it changed, or null when nothing was recorded. */
export function changeKindOf(revision: {
	changeKind?: unknown;
	provenance?: Bag | null;
}): ChangeKind | null {
	const direct = revision.changeKind;
	const extra = bag(bag(revision.provenance).extra).changeKind;
	const value = typeof direct === "string" ? direct : extra;
	return typeof value === "string" && (CHANGE_KINDS as string[]).includes(value)
		? (value as ChangeKind)
		: null;
}

const MEMBERSHIP_KINDS = new Set<ChangeKind>(["withdraw", "restore"]);

/**
 * Whether a host has reworded this finding. Withdrawing and restoring are
 * authored too, and they change no words, so they leave no mark.
 */
export function isEdited(item: {
	changeKind?: unknown;
	provenance?: Bag | null;
}): boolean {
	if (text(bag(item.provenance).origin) !== "authored") return false;
	const kind = changeKindOf(item);
	return kind === null || !MEMBERSHIP_KINDS.has(kind);
}

/** The words of one field, as the host would read them. */
export function fieldWords(
	item: { payload?: Bag | null; detail?: unknown },
	field: EditableField,
): string {
	return text(resultFields(item)[field]);
}

/** The second line of a row: the knot, the role, and nothing for a popcorn. */
export function secondaryField(type: string): EditableField | null {
	if (type === "tension") return "knot";
	if (type === "stakeholder") return "role";
	return null;
}

/**
 * What a fact-check said about this finding, where the object carries one. The
 * list endpoint is growing this field; until then most objects have none.
 */
export function factCheckVerdict(item: {
	attributes?: Bag | null;
	detail?: unknown;
}): string | null {
	const attributes = bag(item.attributes);
	const assessment = bag(attributes.assessment ?? bag(item.detail).assessment);
	const verdict = assessment.verdict ?? attributes.verdict;
	return typeof verdict === "string" && verdict ? verdict : null;
}

/** The wording of a revision, for the before and after of a history entry. */
export function revisionWording(revision: AnalysisRevision): string {
	return primaryText(revision.type, bag(revision.payload));
}
