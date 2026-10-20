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
// A paragraph that reaches either limit is broken, so a meeting with few pauses is not one wall of text.
const PARAGRAPH_MAX_SECONDS = 45;
const PARAGRAPH_MAX_SENTENCES = 5;

type Indexed = { sentence: FinalSentence; index: number };

/** Splits one run of sentences, with no long pause inside it, at its widest gaps once it grows past the limits. */
function splitRun(run: Indexed[]): Indexed[][] {
	const out: Indexed[][] = [];
	let from = 0;
	while (from < run.length) {
		let i = from;
		while (
			i < run.length &&
			i - from + 1 < PARAGRAPH_MAX_SENTENCES &&
			(run[i] as Indexed).sentence.end - (run[from] as Indexed).sentence.start <
				PARAGRAPH_MAX_SECONDS
		)
			i++;
		// Fits, or the limit is reached on the very last sentence: keep the rest whole.
		if (i >= run.length - 1) {
			out.push(run.slice(from));
			break;
		}
		// Limit reached at i: break at the widest gap in the later half, so breaks fall where the speaker paused most.
		const count = i - from + 1;
		let best = i + 1;
		let bestGap = Number.NEGATIVE_INFINITY;
		for (
			let k = from + Math.ceil(count / 2);
			k <= i + 1 && k < run.length;
			k++
		) {
			const gap =
				(run[k] as Indexed).sentence.start -
				(run[k - 1] as Indexed).sentence.end;
			if (gap >= bestGap) {
				bestGap = gap;
				best = k;
			}
		}
		out.push(run.slice(from, best));
		from = best;
	}
	return out;
}

/** The segments in paragraphs: a new one after a pause of more than two seconds, and inside a long run at the widest gap once it reaches about 45 seconds or 5 sentences. Each keeps its index for highlight and seek. */
export function paragraphs(sentences: readonly FinalSentence[]): Indexed[][] {
	const runs: Indexed[][] = [];
	let last = Number.NEGATIVE_INFINITY;
	sentences.forEach((sentence, index) => {
		if (!runs.length || sentence.start - last > PARAGRAPH_PAUSE_SECONDS)
			runs.push([]);
		(runs[runs.length - 1] as Indexed[]).push({ index, sentence });
		last = sentence.end;
	});
	return runs.flatMap(splitRun);
}
