import { useCallback, useRef, useState } from "react";

/**
 * The rows a host has ticked, so one decision can be made about many.
 *
 * The selection is the tab's: changing tabs clears it, because "hide these
 * eleven" means the eleven in front of the host and nothing else.
 */
export function useSelection() {
	const [chosen, setChosen] = useState<string[]>([]);
	// Where the last tick landed, so Shift can reach from there to here.
	const anchor = useRef<string | null>(null);

	const clear = useCallback(() => {
		setChosen([]);
		anchor.current = null;
	}, []);

	const toggle = useCallback(
		(objectId: string, order: string[], range = false) => {
			setChosen((old) => {
				const from = anchor.current ? order.indexOf(anchor.current) : -1;
				const to = order.indexOf(objectId);
				if (range && from >= 0 && to >= 0) {
					const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
					return [...new Set([...old, ...span])];
				}
				return old.includes(objectId)
					? old.filter((id) => id !== objectId)
					: [...old, objectId];
			});
			anchor.current = objectId;
		},
		[],
	);

	const toggleAll = useCallback((order: string[]) => {
		setChosen((old) => (order.every((id) => old.includes(id)) ? [] : order));
		anchor.current = null;
	}, []);

	return {
		chosen,
		clear,
		has: (objectId: string) => chosen.includes(objectId),
		/** None of the shown rows, some of them, or all of them. */
		state: (order: string[]): "none" | "some" | "all" => {
			const held = order.filter((id) => chosen.includes(id)).length;
			if (held === 0) return "none";
			return held === order.length ? "all" : "some";
		},
		toggle,
		toggleAll,
	};
}

export type Selection = ReturnType<typeof useSelection>;
