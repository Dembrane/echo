export const PRESENTATION_BLOCKS = [
	"popcorn",
	"tensions",
	"map",
	"stakeholders",
] as const;

export type PresentationBlock = (typeof PRESENTATION_BLOCKS)[number];

// Tabs follow recipe complexity, including presentations saved in an older order.
export const orderedBlocks = (
	selected: readonly unknown[],
): PresentationBlock[] =>
	PRESENTATION_BLOCKS.filter((block) => selected.includes(block));
