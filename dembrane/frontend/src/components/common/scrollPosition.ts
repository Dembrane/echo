/** How far from the bottom still counts as "at the bottom". Wide enough to
 * absorb sub-pixel rounding and a line of streaming text. */
export const BOTTOM_THRESHOLD_PX = 64;
/** Below this, the content does not meaningfully scroll and the button is noise. */
export const SCROLLABLE_THRESHOLD_PX = 8;

interface ScrollMetrics {
	clientHeight: number;
	scrollHeight: number;
	scrollTop: number;
}

export const evaluateScrollPosition = ({
	clientHeight,
	scrollHeight,
	scrollTop,
}: ScrollMetrics) => {
	const scrollable = scrollHeight - clientHeight > SCROLLABLE_THRESHOLD_PX;
	const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
	const isAtBottom = !scrollable || distanceFromBottom <= BOTTOM_THRESHOLD_PX;
	return {
		distanceFromBottom,
		isAtBottom,
		scrollable,
		showScrollButton: scrollable && !isAtBottom,
	};
};

/** The scroll container is not the same element on every surface: the agentic
 * thread scrolls itself, the classic chat page scrolls an ancestor. Resolve it
 * from an anchor instead of asking each caller to know.
 *
 * Resolution is by overflow style alone, never by current scrollability:
 * this runs at mount, when a thread is often still empty, and a container
 * skipped for not overflowing YET would leave every listener bound to the
 * wrong target after the messages load. */
export const resolveScrollContainer = (
	element: HTMLElement | null,
): HTMLElement | null => {
	if (!element) return null;
	let current: HTMLElement | null = element;
	while (current) {
		const { overflowY } = window.getComputedStyle(current);
		if (overflowY === "auto" || overflowY === "scroll") return current;
		current = current.parentElement;
	}
	return (
		(document.scrollingElement as HTMLElement | null) ??
		document.documentElement
	);
};
