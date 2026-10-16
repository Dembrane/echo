export type FinalSentence = { start: number; end: number; text: string };

export type FinalTranscriptData =
	| { available: false; expected?: boolean }
	| { available: true; locked: true }
	| {
			available: true;
			locked: false;
			provider: string;
			model: string | null;
			text: string;
			sentences: FinalSentence[];
			audio_url: string | null;
	  };

// A long pause after a sentence ends the highlight instead of holding it for minutes.
const HOLD_AFTER_END_SECONDS = 2;

/**
 * The sentence being spoken at `time`: the last one that has started, kept until the next
 * begins or a pause of a couple of seconds passes. Sentences are in order, so this is a
 * binary search; it runs on every playback tick.
 */
export function activeSentenceIndex(
	sentences: readonly FinalSentence[],
	time: number,
): number {
	let lo = 0;
	let hi = sentences.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((sentences[mid] as FinalSentence).start <= time) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	if (found < 0) return -1;
	const s = sentences[found] as FinalSentence;
	return time > s.end + HOLD_AFTER_END_SECONDS ? -1 : found;
}

// A pause this long between two segments starts a new paragraph.
const PARAGRAPH_PAUSE_SECONDS = 2;

/** The segments in paragraphs, a new one after a pause of more than two seconds; each keeps its index for highlight and seek. */
export function paragraphs(
	sentences: readonly FinalSentence[],
): { sentence: FinalSentence; index: number }[][] {
	const out: { sentence: FinalSentence; index: number }[][] = [];
	let last = Number.NEGATIVE_INFINITY;
	sentences.forEach((sentence, index) => {
		if (!out.length || sentence.start - last > PARAGRAPH_PAUSE_SECONDS)
			out.push([]);
		(out[out.length - 1] as { sentence: FinalSentence; index: number }[]).push({
			sentence,
			index,
		});
		last = sentence.end;
	});
	return out;
}
