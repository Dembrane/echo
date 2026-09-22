import { useCallback, useState } from "react";
import { DEFAULT_WALK_INTERVAL_MS } from "../renderers/MstGraph";
import type { MapGraphNode } from "../types";

export type ShowcaseWalkState = {
	/** The node the walk stands on; null before its first step. */
	nodeId: string | null;
	/** When the walk moves on; null while no timer runs. */
	expiresAt: number | null;
	/** The interval the countdown fills, so the bar matches the walk. */
	durationMs: number;
};

const IDLE: ShowcaseWalkState = {
	durationMs: DEFAULT_WALK_INTERVAL_MS,
	expiresAt: null,
	nodeId: null,
};

export type ShowcaseWalk = ShowcaseWalkState & {
	/** Handed to the renderers as `onActiveNodeChange`. */
	onActiveNodeChange: (
		node: MapGraphNode | null,
		expiresAt: number | null,
		durationMs: number,
	) => void;
};

/**
 * What the Showcase panel shows: the node the renderers' walk stands on and
 * the countdown to its next step. The timer itself belongs to the renderers
 * (`autoAdvance` on the MST map), so it stops with them when they unmount and
 * starts again from the current selection when they come back.
 */
export function useShowcaseWalk(): ShowcaseWalk {
	const [walk, setWalk] = useState<ShowcaseWalkState>(IDLE);
	const onActiveNodeChange = useCallback(
		(node: MapGraphNode | null, expiresAt: number | null, durationMs: number) =>
			setWalk({ durationMs, expiresAt, nodeId: node?.id ?? null }),
		[],
	);
	return { ...walk, onActiveNodeChange };
}
