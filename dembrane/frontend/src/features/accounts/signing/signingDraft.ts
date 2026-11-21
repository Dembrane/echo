import type { FieldValue, Values } from "./fieldStepper";

/**
 * What a signer filled in so far, kept per document for the rest of the browser session,
 * so a reload or a lost connection picks up at the same field. Only the typed and ticked
 * values and where the walk was: never the signature or initials image, nor anything made
 * from it; the signer draws it again. A draft belongs to the person who wrote it and to
 * the file they saw: another sign-in, or a changed document, starts clean.
 *
 * Every storage access is wrapped: with storage blocked the walk works as before, it just
 * does not survive a reload.
 */

export const SIGNING_DRAFT_PREFIX = "dembrane_signing_draft:";

export interface SigningDraft {
	/** The signed-in person the values belong to. */
	readonly owner: string;
	/** The document's file as the signer saw it; a new file means a new draft. */
	readonly sha256: string | null;
	readonly values: Values;
	/** The field the walk was on, or null at the start. */
	readonly current: string | null;
	/** On the last step, Review and sign. */
	readonly finishing: boolean;
	readonly visited: readonly string[];
}

/** The fields a draft may hold values for: everything but the drawn images. */
export interface DraftField {
	readonly id: string;
	readonly kind: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
	readonly length: number;
	key(index: number): string | null;
};

const session = (): StorageLike | null => {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
};

export const draftKey = (docId: string) => `${SIGNING_DRAFT_PREFIX}${docId}`;

const isImage = (kind: string) => kind === "signature" || kind === "initials";

/**
 * Only plain values for the document's own non-image fields, plus the extra step ids the
 * walk adds (the "pick one" step). Anything else is dropped.
 */
export function cleanValues(
	values: unknown,
	fields: readonly DraftField[],
	extraIds: readonly string[] = [],
): Values {
	const out: Values = {};
	if (!values || typeof values !== "object") return out;
	const allowed = new Set([
		...fields.filter((f) => !isImage(f.kind)).map((f) => f.id),
		...extraIds,
	]);
	for (const [id, v] of Object.entries(values as Record<string, unknown>)) {
		if (!allowed.has(id)) continue;
		if (typeof v === "string" || typeof v === "boolean")
			out[id] = v as FieldValue;
	}
	return out;
}

/**
 * The stored draft for this document, when it belongs to `owner` and the same file. A
 * draft that is someone else's, for another file, or unreadable is removed.
 */
export function readDraft(
	docId: string,
	expect: {
		owner: string;
		sha256: string | null;
		fields: readonly DraftField[];
		extraIds?: readonly string[];
	},
	storage: StorageLike | null = session(),
): SigningDraft | null {
	if (!storage) return null;
	let raw: string | null = null;
	try {
		raw = storage.getItem(draftKey(docId));
	} catch {
		return null;
	}
	if (!raw) return null;
	let parsed: Partial<SigningDraft> | null = null;
	try {
		parsed = JSON.parse(raw) as Partial<SigningDraft>;
	} catch {
		parsed = null;
	}
	if (
		!parsed ||
		parsed.owner !== expect.owner ||
		(parsed.sha256 ?? null) !== expect.sha256
	) {
		clearDraft(docId, storage);
		return null;
	}
	const steps = new Set([
		...expect.fields.map((f) => f.id),
		...(expect.extraIds ?? []),
	]);
	const current =
		typeof parsed.current === "string" && steps.has(parsed.current)
			? parsed.current
			: null;
	return {
		current,
		finishing: parsed.finishing === true,
		owner: expect.owner,
		sha256: expect.sha256,
		values: cleanValues(parsed.values, expect.fields, expect.extraIds),
		visited: Array.isArray(parsed.visited)
			? parsed.visited.filter(
					(id): id is string => typeof id === "string" && steps.has(id),
				)
			: [],
	};
}

/**
 * Keeps the draft; the values are cleaned again so no image can slip in. False when the
 * browser would not store it, so the page knows a reload would lose the input.
 */
export function writeDraft(
	docId: string,
	draft: SigningDraft,
	fields: readonly DraftField[],
	extraIds: readonly string[] = [],
	storage: StorageLike | null = session(),
): boolean {
	if (!storage) return false;
	const out: SigningDraft = {
		current: draft.current,
		finishing: draft.finishing,
		owner: draft.owner,
		sha256: draft.sha256,
		values: cleanValues(draft.values, fields, extraIds),
		visited: [...draft.visited],
	};
	try {
		storage.setItem(draftKey(docId), JSON.stringify(out));
		return true;
	} catch {
		return false;
	}
}

export function clearDraft(
	docId: string,
	storage: StorageLike | null = session(),
): void {
	try {
		storage?.removeItem(draftKey(docId));
	} catch {}
}

/** Every signing draft in this browser session: on sign-in, sign-out and account switch. */
export function clearAllDrafts(storage: StorageLike | null = session()): void {
	if (!storage) return;
	try {
		const keys: string[] = [];
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key?.startsWith(SIGNING_DRAFT_PREFIX)) keys.push(key);
		}
		for (const key of keys) storage.removeItem(key);
	} catch {}
}
