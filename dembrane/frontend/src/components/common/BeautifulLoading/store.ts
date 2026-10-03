/** How many parts of the page are waiting right now. Every BeautifulLoading
 * counts itself in while it is mounted; the one LoadingStage reads the count,
 * so a chain of loaders (language, sign-in, project, page) reads as one wait
 * instead of a new fade-in, a new quote and a restarted sketch at each step. */

/** "full" while anything waits with a quote, "quiet" while only participant
 * pages wait (the sketches, no quote), "none" when nothing does. */
export type LoadingMode = "none" | "quiet" | "full";

let full = 0;
let quiet = 0;
let mode: LoadingMode = "none";
const listeners = new Set<() => void>();

const emit = () => {
	mode = full > 0 ? "full" : quiet > 0 ? "quiet" : "none";
	for (const listener of listeners) listener();
};

export const loadingStore = {
	getSnapshot: () => mode,
	/** Counts one waiting part in; the returned function counts it out. */
	hold: (isQuiet = false) => {
		if (isQuiet) quiet += 1;
		else full += 1;
		emit();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (isQuiet) quiet -= 1;
			else full -= 1;
			emit();
		};
	},
	subscribe: (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};
