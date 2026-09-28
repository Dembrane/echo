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

/**
 * Turning one tab on or off in the draft. The presentation editor's switches
 * and the results panel's off-tab both write through this, so there is one
 * shape of patch and one idea of what the block list is.
 */
export const blocksPatch = (
	selected: readonly PresentationBlock[],
	block: PresentationBlock,
	on: boolean,
): { blocks: PresentationBlock[] } => ({
	blocks: orderedBlocks(
		on ? [...selected, block] : selected.filter((item) => item !== block),
	),
});
