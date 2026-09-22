export const PRESENTATION_BLOCKS = [
	"popcorn",
	"tensions",
	"map",
	"stakeholders",
] as const;

export type PresentationBlock = (typeof PRESENTATION_BLOCKS)[number];

// The screen is Popcorn first: it is ready long before the rest, so the room
// always has something to read. It is not a choice the host can undo.
export const ALWAYS_ON_BLOCK: PresentationBlock = "popcorn";

// Tabs follow recipe complexity, including presentations saved in an older order.
export const orderedBlocks = (
	selected: readonly unknown[],
): PresentationBlock[] =>
	PRESENTATION_BLOCKS.filter((block) => selected.includes(block));
