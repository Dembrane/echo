import { plural } from "@lingui/core/macro";
import type { AnalysisRevision } from "@/components/analysis/hooks";

/** The kinds a finding can take. Anything else renders as its label alone. */
export type ResultKind =
	| "popcorn"
	| "tension"
	| "stakeholder"
	| "argument"
	| "deduplicated_argument";

/**
 * What a reason has to be, trimmed, before anything is sent. The server keeps
 * the same two numbers (`check_change_kind` in `dembrane/analysis/revisions.py`)
 * and the host never sees either of them: under the minimum the prompt asks for
 * a few more words.
 */
export const MEANING_REASON_MIN = 12;
export const WITHDRAW_REASON_MIN = 4;

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
 * The evidence count. The server counts it for the list, over the whole
 * payload; a reader that carries only a sanitized object (the map) counts what
 * it has, and a payload that withholds its quotes counts the conversations it
 * names.
 */
export function resultEvidence(item: {
	detail?: unknown;
	provenance?: Bag | null;
	quoteCount?: number;
	conversationCount?: number;
}): ResultEvidence {
	if (
		typeof item.quoteCount === "number" ||
		typeof item.conversationCount === "number"
	)
		return {
			conversations: item.conversationCount ?? 0,
			quotes: item.quoteCount ?? 0,
		};
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

/**
 * Whether the evidence can be said as "1 quote from Marloes": every quote
 * comes from one conversation, and a host is reading, so the name is there.
 * A room and a public viewer never carry the name and always read the counts.
 */
export const namesOneConversation = (
	evidence: ResultEvidence,
	name?: string | null,
): boolean =>
	Boolean(evidence.quotes > 0 && evidence.conversations === 1 && name);

/**
 * Whether a row rises to the top of its group. "one quote only" and "one
 * conversation only" say nothing an evidence line reading "1 quote from
 * Marloes" has not already said: the row keeps its phrase-less place among
 * the rest rather than taking one of the twenty a group shows at rest.
 */
export function risesForAttention(item: {
	attention?: string | null;
	conversationName?: string | null;
	detail?: unknown;
	provenance?: Bag | null;
	quoteCount?: number;
	conversationCount?: number;
}): boolean {
	if (!item.attention) return false;
	if (item.attention !== "one_quote" && item.attention !== "one_conversation")
		return true;
	return !namesOneConversation(resultEvidence(item), item.conversationName);
}

/**
 * What a finding rests on, in words. One conversation with a name says which
 * one, and then says it once: the count of conversations is in the sentence.
 */
export function evidenceWords(
	evidence: ResultEvidence,
	name?: string | null,
): string {
	// Named, so the plural's own variables carry the wording the catalogs
	// already hold.
	const { conversations, quotes } = evidence;
	// Nothing to count is nothing to say: the room's payload carries no
	// evidence, and "0 conversations" would read as a finding nobody made.
	if (!quotes && !conversations) return "";
	if (namesOneConversation(evidence, name))
		return plural(quotes, {
			one: `# quote from ${name}`,
			other: `# quotes from ${name}`,
		});
	const quoteWords = plural(quotes, { one: "# quote", other: "# quotes" });
	const conversationWords = plural(conversations, {
		one: "# conversation",
		other: "# conversations",
	});
	if (!quotes) return conversationWords;
	if (!conversations) return quoteWords;
	return `${quoteWords} · ${conversationWords}`;
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
 * Whether a host has reworded this finding. The server reads the whole history
 * and says so outright; a reader without that field reads the revision it has,
 * where withdrawing and restoring are authored too and leave no mark, because
 * they change no words.
 */
export function isEdited(item: {
	changeKind?: unknown;
	edited?: boolean;
	provenance?: Bag | null;
}): boolean {
	if (typeof item.edited === "boolean") return item.edited;
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
 * What a fact-check said about this finding. The list endpoint sends the
 * verdict of this very revision; elsewhere it is read from what the object
 * carries, and most objects carry none.
 */
export function factCheckVerdict(item: {
	attributes?: Bag | null;
	detail?: unknown;
	verdict?: string | null;
}): string | null {
	if (typeof item.verdict === "string" && item.verdict) return item.verdict;
	const attributes = bag(item.attributes);
	const assessment = bag(attributes.assessment ?? bag(item.detail).assessment);
	const verdict = assessment.verdict ?? attributes.verdict;
	return typeof verdict === "string" && verdict ? verdict : null;
}

/** The wording of a revision, for the before and after of a history entry. */
export function revisionWording(revision: AnalysisRevision): string {
	return primaryText(revision.type, bag(revision.payload));
}

/** One conversation's worth of evidence, as the curate views read it. */
export type EvidenceGroup = {
	conversationId: string;
	/** The conversation's own name, where the payload carries one. */
	label: string;
	quotes: string[];
};

/**
 * The evidence of a finding, grouped by conversation. The server sends
 * `detail.evidence` for arguments and popcorn as the recipe wrote it, and
 * synthesises it for tensions and stakeholders from their flat `quotes`
 * (`_quotes_as_evidence` in `dembrane/analysis/map_view.py`), which keeps the
 * conversation but not the name.
 */
export function evidenceGroups(item: {
	detail?: unknown;
	provenance?: Bag | null;
}): EvidenceGroup[] {
	const fromDetail = groups(item)
		.map((group) => ({
			conversationId: text(group.conversationId),
			label: text((group as Bag).label),
			quotes: (Array.isArray(group.quotes) ? group.quotes : [])
				.map(text)
				.filter(Boolean),
		}))
		.filter((group) => group.quotes.length > 0 || group.conversationId);
	if (fromDetail.length > 0) return fromDetail;
	// A reader with only the provenance refs: one quote each, gathered by the
	// conversation they came from.
	const byConversation = new Map<string, EvidenceGroup>();
	for (const ref of sourceRefs(item)) {
		const quote = text(ref.quote);
		if (!quote) continue;
		const conversationId = text(ref.conversationId);
		const group = byConversation.get(conversationId) ?? {
			conversationId,
			label: "",
			quotes: [],
		};
		group.quotes.push(quote);
		byConversation.set(conversationId, group);
	}
	return [...byConversation.values()];
}

/**
 * What to call a conversation in a list a host is reading. The payload names
 * it where the recipe recorded a label; otherwise the only name on the wire is
 * the top-level one, which the server sends when a finding rests on a single
 * conversation. Nameless is nameless: the line says nothing rather than an id.
 */
export function conversationWords(
	item: { conversationName?: string | null; conversationCount?: number },
	group?: Pick<EvidenceGroup, "label"> | null,
): string {
	if (group?.label) return group.label;
	return text(item.conversationName);
}

/** A quote of a tension, and which pole it stands for where that was kept. */
export type PoleQuote = {
	text: string;
	conversationId: string;
	pole: "A" | "B" | null;
};

/**
 * A tension's own quotes, each with the pole it supports. The tensions recipe
 * writes `pole` on every quote (`recipes/tensions.py`); tensions imported from
 * an older popcorn carry none, and those read as one list.
 */
export function tensionQuotes(item: {
	payload?: Bag | null;
	detail?: unknown;
}): PoleQuote[] {
	const raw = resultFields(item).quotes;
	if (!Array.isArray(raw)) return [];
	return raw
		.map((entry) => {
			const quote = bag(entry);
			const pole = quote.pole;
			return {
				conversationId: text(quote.conversationId),
				pole: pole === "A" || pole === "B" ? pole : null,
				text: text(quote.text),
			};
		})
		.filter((quote) => quote.text);
}

/** Whether a tension's quotes say which pole they stand for. */
export const hasPoles = (quotes: PoleQuote[]): boolean =>
	quotes.some((quote) => quote.pole !== null);

/**
 * Why a fact-check said what it said, where the reader has it. The results
 * list endpoint sends the verdict alone (`_verdicts` in the bff's
 * `analysis.py`); a reader that carries the whole assessment shows the
 * sentence under it.
 */
export function factCheckJustification(item: {
	attributes?: Bag | null;
	detail?: unknown;
}): string {
	const attributes = bag(item.attributes);
	const assessment = bag(attributes.assessment ?? bag(item.detail).assessment);
	return text(assessment.justification ?? attributes.justification);
}

/**
 * Where a phrase sits inside the sentence it was cut from, by plain
 * case-insensitive match. Nothing found is nothing marked: the quote is read
 * as it stands rather than guessed at.
 */
export function cutFrom(
	quote: string,
	phrase: string,
): { before: string; match: string; after: string } | null {
	const needle = phrase.trim();
	if (!needle) return null;
	const at = quote.toLowerCase().indexOf(needle.toLowerCase());
	if (at < 0) return null;
	return {
		after: quote.slice(at + needle.length),
		before: quote.slice(0, at),
		match: quote.slice(at, at + needle.length),
	};
}

/** What made a revision: "generated", "imported", "authored", or nothing. */
export function revisionOrigin(revision: { provenance?: Bag | null }): string {
	return text(bag(revision.provenance).origin);
}

/**
 * Whether a person made this revision. History is what people did: a run's
 * own bookkeeping (a vector repair, a rerun that changed the provenance and
 * not a word) is not something anyone did to the finding. `origin` is the
 * server's word for it and rides on every revision; an actor is the fallback
 * where a revision carries no origin at all.
 */
export function isHumanRevision(revision: {
	actorId?: string | null;
	provenance?: Bag | null;
}): boolean {
	const origin = revisionOrigin(revision);
	if (origin === "authored") return true;
	if (origin) return false;
	return Boolean(revision.actorId);
}

/** One line of history: a person's revision, and the wording it replaced. */
export type HistoryEntry = {
	revision: AnalysisRevision;
	/**
	 * The wording of the revision immediately before it in the full list,
	 * machine ones included, so the diff stays true.
	 */
	before: string;
	after: string;
	/** Whether this wording is one the host can bring back. */
	offerRestore: boolean;
};

/**
 * The timeline, newest first: only what people did. `current` is the wording
 * on the card, so the host is never offered the words already in front of
 * them, and never the same words twice.
 */
export function humanHistory(
	revisions: AnalysisRevision[],
	current: string,
): HistoryEntry[] {
	const entries: HistoryEntry[] = [];
	// The list arrives oldest first, which is where a "before" comes from.
	revisions.forEach((revision, index) => {
		if (!isHumanRevision(revision)) return;
		const previous = revisions[index - 1];
		entries.push({
			after: revisionWording(revision),
			before: previous ? revisionWording(previous) : "",
			offerRestore: false,
			revision,
		});
	});
	entries.reverse();
	const offered = new Set<string>();
	return entries.map((entry) => {
		const offerRestore =
			Boolean(entry.after) &&
			entry.after !== current &&
			!offered.has(entry.after);
		if (offerRestore) offered.add(entry.after);
		return { ...entry, offerRestore };
	});
}

/**
 * Where a finding came from, in one line's worth of facts: what made its
 * first revision, and when. The machine is an origin, not a history.
 */
export function analysisOrigin(
	revisions: AnalysisRevision[],
	item?: { provenance?: Bag | null },
): { origin: string; at: string | null } {
	const first = revisions[0];
	if (first)
		return { at: first.publishedAt ?? null, origin: revisionOrigin(first) };
	return { at: null, origin: item ? revisionOrigin(item) : "" };
}
