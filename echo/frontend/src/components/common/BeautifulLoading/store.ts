/** How many parts of the page are waiting right now. Every BeautifulLoading
 * counts itself in while it is mounted; the one LoadingStage reads the count,
 * so a chain of loaders (language, sign-in, project, page) reads as one wait
 * instead of a new fade-in, a new quote and a restarted sketch at each step. */

let waiting = 0;
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

export const loadingStore = {
	getSnapshot: () => waiting > 0,
	/** Counts one waiting part in; the returned function counts it out. */
	hold: () => {
		waiting += 1;
		emit();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			waiting -= 1;
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
