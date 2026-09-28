import {
	createContext,
	type ReactNode,
	useContext,
	useState,
	useSyncExternalStore,
} from "react";
import type { HighlightSource } from "../types";

export type HighlightUpdateOptions = {
	source?: HighlightSource;
	isPreview?: boolean;
};

export type MapInteractionValues = {
	selectedNodeId: string | null;
	highlightedNodeIds: Set<string>;
	/** Distance from the cursor or hovered node (0-1, where 0 is closest). */
	highlightedNodesDistance: Map<string, number>;
	highlightSource: HighlightSource;
	highlightIsPreview: boolean;
	highlightUpdatedAt: number;
	/**
	 * Counts selections. Every setSelectedNodeId bumps it, also when the id is
	 * unchanged, so selecting the selected node again can restart the walk.
	 */
	selectionRevision: number;
};

export type MapInteractionActions = {
	setSelectedNodeId: (id: string | null) => void;
	setHighlightedNodeIds: (
		ids: Set<string>,
		options?: HighlightUpdateOptions,
	) => void;
	setHighlightedNodesDistance: (distances: Map<string, number>) => void;
};

export type MapInteractionState = MapInteractionValues & MapInteractionActions;

export type MapInteractionStore = MapInteractionActions & {
	getState: () => MapInteractionState;
	setState: (
		partial:
			| Partial<MapInteractionValues>
			| ((state: MapInteractionState) => Partial<MapInteractionValues>),
	) => void;
	subscribe: (listener: () => void) => () => void;
};

const areSetsEqual = (a: Set<string>, b: Set<string>) => {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
};

const areMapsEqual = (a: Map<string, number>, b: Map<string, number>) => {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) {
		if (!b.has(key) || b.get(key) !== value) return false;
	}
	return true;
};

/**
 * Selection and highlight state shared by the renderers of one Map page.
 * Updates that return the current state object are skipped without
 * notifying subscribers.
 */
export function createMapInteractionStore(
	initial?: Partial<MapInteractionValues>,
): MapInteractionStore {
	const listeners = new Set<() => void>();

	const setState: MapInteractionStore["setState"] = (partial) => {
		const next = typeof partial === "function" ? partial(state) : partial;
		if (Object.is(next, state)) return;
		state = { ...state, ...next };
		for (const listener of listeners) {
			listener();
		}
	};

	const actions: MapInteractionActions = {
		setHighlightedNodeIds: (ids, options) =>
			setState((current) => {
				const setsMatch = areSetsEqual(current.highlightedNodeIds, ids);
				const shouldUpdateMeta = Boolean(
					options && ("source" in options || "isPreview" in options),
				);

				if (setsMatch && !shouldUpdateMeta) {
					return current;
				}

				return {
					highlightedNodeIds: setsMatch ? current.highlightedNodeIds : ids,
					highlightIsPreview: options?.isPreview ?? false,
					highlightSource:
						options?.source ??
						(setsMatch ? current.highlightSource : "unknown"),
					highlightUpdatedAt: Date.now(),
				};
			}),
		setHighlightedNodesDistance: (distances) =>
			setState((current) => {
				if (areMapsEqual(current.highlightedNodesDistance, distances)) {
					return current;
				}
				return { highlightedNodesDistance: distances };
			}),
		setSelectedNodeId: (id) =>
			setState((current) => ({
				selectedNodeId: id,
				selectionRevision: current.selectionRevision + 1,
			})),
	};

	let state: MapInteractionState = {
		highlightedNodeIds: new Set<string>(),
		highlightedNodesDistance: new Map<string, number>(),
		highlightIsPreview: false,
		highlightSource: "unknown",
		highlightUpdatedAt: 0,
		selectedNodeId: null,
		selectionRevision: 0,
		...initial,
		...actions,
	};

	return {
		...actions,
		getState: () => state,
		setState,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

const MapInteractionContext = createContext<MapInteractionStore | null>(null);

/**
 * Provides a Map page's interaction store. Pass `store` to drive selection
 * and highlight from outside (a fixture, a presenter display); otherwise the
 * provider creates its own.
 */
export function MapInteractionProvider({
	store,
	children,
}: {
	store?: MapInteractionStore;
	children: ReactNode;
}) {
	const [ownStore] = useState(() => store ?? createMapInteractionStore());
	return (
		<MapInteractionContext.Provider value={store ?? ownStore}>
			{children}
		</MapInteractionContext.Provider>
	);
}

/** The store itself, for getState() reads inside event handlers. */
export function useMapInteractionStore(): MapInteractionStore {
	const store = useContext(MapInteractionContext);
	if (!store) {
		throw new Error(
			"useMapInteractionStore must be used inside a MapInteractionProvider",
		);
	}
	return store;
}

/** Subscribes to one slice of the interaction state. */
export function useMapInteraction<T>(
	selector: (state: MapInteractionState) => T,
): T {
	const store = useMapInteractionStore();
	const getSnapshot = () => selector(store.getState());
	return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
