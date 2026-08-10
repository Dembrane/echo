import { diffWords } from "diff";

/**
 * Word-level diffing for host-facing "here is what would change" views.
 *
 * The side-by-side `DiffViewer` in this folder is built for a full-height
 * modal: four columns, line numbers, its own scroll container, English-only
 * chrome. None of that fits inside a chat card that is at most 80% of the
 * column width, so this module keeps only the part worth sharing, the diff
 * computation, and leaves rendering to the caller.
 */

export type WordDiffChunk = {
	value: string;
	added: boolean;
	removed: boolean;
	/** True when a long unchanged run was shortened to keep the edits on screen. */
	elided?: boolean;
};

export type WordDiffResult = {
	chunks: WordDiffChunk[];
	addedWords: number;
	removedWords: number;
	/** False when the two texts are word for word identical. */
	hasChanges: boolean;
	/** True when the diff could not be computed, so the caller should fall back
	 * to showing both values whole. */
	unavailable: boolean;
};

/** Diffing is O(n*d); a pathological pair of long texts should degrade to the
 * plain before/after view rather than freeze the chat. */
const DIFF_TIMEOUT_MS = 250;
const MAX_DIFFABLE_CHARS = 40_000;

export const ELISION_MARK = " … ";

const countWords = (value: string) => {
	const trimmed = value.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
};

/** Cuts to a word boundary so an elided run never ends mid-word. */
const takeHead = (value: string, chars: number) => {
	const slice = value.slice(0, chars);
	const boundary = slice.lastIndexOf(" ");
	return boundary <= 0 ? slice : slice.slice(0, boundary);
};

const takeTail = (value: string, chars: number) => {
	const slice = value.slice(-chars);
	const boundary = slice.indexOf(" ");
	return boundary === -1 ? slice : slice.slice(boundary + 1);
};

/**
 * Shortens long unchanged runs so the changed words stay visible without
 * scrolling past paragraphs of identical text. Context is kept on whichever
 * side of the run touches an edit, so the reader still sees where the edit
 * lands rather than a floating fragment.
 */
export const elideUnchangedRuns = (
	chunks: WordDiffChunk[],
	contextChars = 140,
): WordDiffChunk[] => {
	// A single chunk means nothing changed; there is nothing to keep in view.
	if (chunks.length < 2) return chunks;
	return chunks.map((chunk, index) => {
		if (chunk.added || chunk.removed) return chunk;
		const isFirst = index === 0;
		const isLast = index === chunks.length - 1;
		const budget = isFirst || isLast ? contextChars : contextChars * 2;
		if (chunk.value.length <= budget + ELISION_MARK.length) return chunk;
		if (isFirst) {
			return {
				...chunk,
				elided: true,
				value: ELISION_MARK + takeTail(chunk.value, contextChars),
			};
		}
		if (isLast) {
			return {
				...chunk,
				elided: true,
				value: takeHead(chunk.value, contextChars) + ELISION_MARK,
			};
		}
		return {
			...chunk,
			elided: true,
			value:
				takeHead(chunk.value, contextChars) +
				ELISION_MARK +
				takeTail(chunk.value, contextChars),
		};
	});
};

export const buildWordDiff = (
	current: string,
	proposed: string,
): WordDiffResult => {
	const left = current ?? "";
	const right = proposed ?? "";
	const bail = {
		addedWords: 0,
		chunks: [] as WordDiffChunk[],
		hasChanges: left !== right,
		removedWords: 0,
		unavailable: true,
	};
	if (left.length > MAX_DIFFABLE_CHARS || right.length > MAX_DIFFABLE_CHARS) {
		return bail;
	}
	const parts = diffWords(left, right, { timeout: DIFF_TIMEOUT_MS });
	if (!parts) return bail;

	let addedWords = 0;
	let removedWords = 0;
	const chunks: WordDiffChunk[] = parts.map((part) => {
		if (part.added) addedWords += countWords(part.value);
		if (part.removed) removedWords += countWords(part.value);
		return { added: part.added, removed: part.removed, value: part.value };
	});
	return {
		addedWords,
		chunks,
		hasChanges: addedWords > 0 || removedWords > 0,
		removedWords,
		unavailable: false,
	};
};

/** Long or multi-line values read better as an inline word diff than as a
 * single "old then new" line. */
export const needsWordDiff = (current: unknown, proposed: unknown) => {
	if (typeof proposed !== "string") return false;
	const left = typeof current === "string" ? current : "";
	return (
		left.length > 80 ||
		proposed.length > 80 ||
		left.includes("\n") ||
		proposed.includes("\n")
	);
};
