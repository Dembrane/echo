import { useCallback, useEffect, useRef, useState } from "react";
import { centralityOrder } from "../graph/mst";
import { useMapInteractionStore } from "../state/interactionStore";
import type { Edge, MapGraphNode } from "../types";
import {
	type HttpError,
	requestSelectionTitle,
	type SelectionTitleContext,
} from "./index";

/** A settled highlight must hold this long before it is titled. */
export const TITLE_DELAY_MS = 1500;
/** Smaller selections are never titled. */
export const MIN_TITLE_NODES = 3;

export type DistillationStatus = "pending" | "done" | "failed" | "too-large";

export type Distillation = {
	id: string;
	/** Result id plus the sorted node ids: one entry per selection. */
	key: string;
	status: DistillationStatus;
	/** Set once the title has arrived. */
	title?: string;
	/** Most central first. */
	nodeIds: string[];
	/** When it last joined the top of the history. */
	createdAt: string;
};

export type TitleRequester = (
	resultId: string,
	nodeIds: string[],
	signal: AbortSignal,
	context?: SelectionTitleContext,
) => Promise<{ title: string }>;

export type UseSelectionTitleOptions = {
	resultId: string | null;
	/** The snapshot the nodes belong to; null for a legacy result. */
	snapshotId?: string | null;
	/** The placed nodes the renderers show. */
	nodes: ReadonlyArray<MapGraphNode>;
	/** The MST over those nodes, for centrality order. */
	edges: ReadonlyArray<Edge>;
	request?: TitleRequester;
	/**
	 * False where titles must never be asked for (a viewer who is not signed
	 * in): no timer runs and no request is made.
	 */
	enabled?: boolean;
};

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
};

export const selectionKey = (resultId: string, nodeIds: Iterable<string>) =>
	`${resultId}::${Array.from(nodeIds).sort().join(",")}`;

/**
 * Titles the settled highlight, as DDW's visualizer did: a settled set of at
 * least three nodes that holds for 1.5 s while the cursor arc fills sends one
 * title request. Moving before the arc is full cancels it.
 *
 * Once sent, a request runs in the background: it joins the history at once
 * as pending, and moving the cursor or leaving the maps no longer cancels it.
 * When the newest request lands it is selected (Spotlight shows it) and takes
 * over the highlight, unless the cursor is mid-arc on another set. An older
 * one that lands later only fills in its history entry. Identical selections
 * reuse their title within the session without a request.
 */
export function useSelectionTitle({
	resultId,
	snapshotId = null,
	nodes,
	edges,
	request = requestSelectionTitle,
	enabled = true,
}: UseSelectionTitleOptions) {
	const store = useMapInteractionStore();

	const [history, setHistoryState] = useState<Distillation[]>([]);
	const [selectedDistillationId, setSelectedState] = useState<string | null>(
		null,
	);
	const [timerRun, setTimerRun] = useState<number | null>(null);
	const [timerProgress, setTimerProgress] = useState(0);

	const latestRef = useRef({
		edges,
		enabled,
		nodes,
		request,
		resultId,
		snapshotId,
	});
	latestRef.current = { edges, enabled, nodes, request, resultId, snapshotId };

	const historyRef = useRef<Distillation[]>([]);
	const selectedRef = useRef<string | null>(null);
	const currentTitleRef = useRef<{ key: string; nodeIds: Set<string> } | null>(
		null,
	);
	const currentSetRef = useRef<ReadonlySet<string>>(new Set());
	const metaRef = useRef({ isPreview: false, updatedAt: 0 });
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const timerStartRef = useRef<number | null>(null);
	const timerSeqRef = useRef(0);
	/** In-flight requests by history entry id. */
	const jobsRef = useRef(new Map<string, AbortController>());
	/** The entry of the request sent last: only it may take over Spotlight. */
	const latestJobRef = useRef<string | null>(null);
	const cacheRef = useRef(new Map<string, string>());
	const historySeqRef = useRef(0);

	const setHistory = useCallback((next: Distillation[]) => {
		historyRef.current = next;
		setHistoryState(next);
	}, []);

	/** Puts the entry first, replacing any entry with its id. */
	const putFirst = useCallback(
		(entry: Distillation) =>
			setHistory([
				entry,
				...historyRef.current.filter((item) => item.id !== entry.id),
			]),
		[setHistory],
	);

	const updateEntry = useCallback(
		(id: string, patch: Partial<Distillation>) =>
			setHistory(
				historyRef.current.map((item) =>
					item.id === id ? { ...item, ...patch } : item,
				),
			),
		[setHistory],
	);

	const setSelected = useCallback((id: string | null) => {
		selectedRef.current = id;
		setSelectedState(id);
	}, []);

	const clearTimer = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
		if (timerStartRef.current !== null) {
			timerStartRef.current = null;
			setTimerRun(null);
			setTimerProgress(0);
		}
	}, []);

	const abortAll = useCallback(() => {
		for (const controller of jobsRef.current.values()) controller.abort();
		jobsRef.current.clear();
	}, []);

	const highlightAsHistory = useCallback(
		(nodeIds: string[]) => {
			store.setHighlightedNodeIds(new Set(nodeIds), {
				isPreview: false,
				source: "history",
			});
			store.setHighlightedNodesDistance(
				new Map(nodeIds.map((id) => [id, 0] as const)),
			);
		},
		[store],
	);

	/** A title arrives: Spotlight shows it; the map follows unless mid-arc. */
	const arrive = useCallback(
		(entry: Distillation) => {
			currentTitleRef.current = {
				key: entry.key,
				nodeIds: new Set(entry.nodeIds),
			};
			setSelected(entry.id);
			const busy =
				timerStartRef.current !== null || store.getState().highlightIsPreview;
			if (!busy) highlightAsHistory(entry.nodeIds);
		},
		[highlightAsHistory, setSelected, store],
	);

	const startRequest = useCallback(
		(nodeIds: string[]) => {
			const {
				request: send,
				resultId: id,
				snapshotId: snapshot,
				nodes: graphNodes,
				enabled: mayAsk,
			} = latestRef.current;
			if (!id || !mayAsk) return;
			const key = selectionKey(id, nodeIds);
			const existing = historyRef.current.find((item) => item.key === key);
			if (existing?.status === "pending") return;

			const cached = cacheRef.current.get(key);
			if (cached !== undefined) {
				const entry: Distillation = existing
					? {
							...existing,
							createdAt: new Date().toISOString(),
							status: "done",
							title: cached,
						}
					: {
							createdAt: new Date().toISOString(),
							id: `distillation-${++historySeqRef.current}`,
							key,
							nodeIds,
							status: "done",
							title: cached,
						};
				latestJobRef.current = entry.id;
				putFirst(entry);
				arrive(entry);
				return;
			}

			const entry: Distillation = {
				createdAt: new Date().toISOString(),
				id: existing?.id ?? `distillation-${++historySeqRef.current}`,
				key,
				nodeIds,
				status: "pending",
			};
			putFirst(entry);
			latestJobRef.current = entry.id;

			const revisionOf = new Map(
				graphNodes.map((node) => [node.id, node.metadata.revisionId] as const),
			);
			// Titles are asked for exact revisions of one snapshot.
			const context: SelectionTitleContext = {
				revisionIds: nodeIds.map((nodeId) => revisionOf.get(nodeId) ?? nodeId),
				snapshotId: snapshot ?? null,
			};
			const controller = new AbortController();
			jobsRef.current.set(entry.id, controller);

			send(id, nodeIds, controller.signal, context).then(
				(response) => {
					jobsRef.current.delete(entry.id);
					if (controller.signal.aborted) return;
					const title = response?.title?.trim() ?? "";
					if (!title) {
						updateEntry(entry.id, { status: "failed" });
						return;
					}
					cacheRef.current.set(key, title);
					updateEntry(entry.id, { status: "done", title });
					if (latestJobRef.current === entry.id) {
						arrive({ ...entry, status: "done", title });
					}
				},
				(reason: HttpError) => {
					jobsRef.current.delete(entry.id);
					if (controller.signal.aborted) return;
					updateEntry(entry.id, {
						status: reason?.status === 413 ? "too-large" : "failed",
					});
				},
			);
		},
		[arrive, putFirst, updateEntry],
	);

	/** The settled ids the map can title, or none when too few. */
	const eligibleOf = useCallback((ids: ReadonlySet<string>): string[] => {
		const known = new Set(latestRef.current.nodes.map((node) => node.id));
		const eligible = Array.from(ids).filter((id) => known.has(id));
		return eligible.length < MIN_TITLE_NODES ? [] : eligible;
	}, []);

	const fire = useCallback(
		(ids: ReadonlySet<string>) => {
			timeoutRef.current = null;
			timerStartRef.current = null;
			setTimerRun(null);
			setTimerProgress(0);

			// Every settled node goes to the server; it refuses a selection it
			// cannot title whole rather than trimming it here.
			const eligible = eligibleOf(ids);
			if (eligible.length === 0) return;
			const { edges: treeEdges, nodes: graphNodes } = latestRef.current;
			startRequest(centralityOrder(eligible, graphNodes, treeEdges));
		},
		[eligibleOf, startRequest],
	);

	const handleChange = useCallback(() => {
		const state = store.getState();
		const previous = metaRef.current;
		const previewCommitted =
			previous.isPreview &&
			!state.highlightIsPreview &&
			previous.updatedAt !== state.highlightUpdatedAt;
		metaRef.current = {
			isPreview: state.highlightIsPreview,
			updatedAt: state.highlightUpdatedAt,
		};

		const ids = state.highlightedNodeIds;

		if (ids.size === 0) {
			clearTimer();
			if (currentSetRef.current.size !== 0) currentSetRef.current = new Set();
			return;
		}

		const setsChanged = !setsEqual(ids, currentSetRef.current);

		// Preview highlights (LocalMap while moving) never start the timer.
		if (state.highlightIsPreview) {
			clearTimer();
			if (setsChanged) currentSetRef.current = ids;
			return;
		}

		if (!setsChanged && !previewCommitted) return;

		clearTimer();
		currentSetRef.current = ids;

		// History toggles highlight a titled set; they start nothing.
		if (state.highlightSource === "history") return;

		// Back on the set that already has the current title.
		const currentTitle = currentTitleRef.current;
		if (currentTitle && setsEqual(ids, currentTitle.nodeIds)) return;

		// Already asking for exactly this set.
		const { resultId: id } = latestRef.current;
		if (id) {
			const key = selectionKey(id, ids);
			const asking = historyRef.current.some(
				(item) => item.key === key && item.status === "pending",
			);
			if (asking) return;
		}

		currentTitleRef.current = null;

		// A full arc is a promise: it is only drawn for a set that can be titled.
		if (eligibleOf(ids).length === 0) return;

		timerStartRef.current = Date.now();
		setTimerRun(++timerSeqRef.current);
		timeoutRef.current = setTimeout(() => fire(ids), TITLE_DELAY_MS);
	}, [clearTimer, eligibleOf, fire, store]);

	useEffect(() => {
		if (!enabled) return;
		return store.subscribe(handleChange);
	}, [enabled, store, handleChange]);

	// Switched off mid-selection: nothing pending may still land.
	useEffect(() => {
		if (enabled) return;
		clearTimer();
		abortAll();
	}, [abortAll, clearTimer, enabled]);

	// Cursor arc progress, a full circle over the title delay.
	useEffect(() => {
		if (timerRun === null) return;
		if (typeof requestAnimationFrame !== "function") return;
		let frame = 0;
		const tick = () => {
			const start = timerStartRef.current;
			if (start === null) return;
			const progress = Math.min((Date.now() - start) / TITLE_DELAY_MS, 1);
			setTimerProgress(progress);
			if (progress < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [timerRun]);

	// A new result starts a fresh history.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the result id only
	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
			timerStartRef.current = null;
			abortAll();
			latestJobRef.current = null;
			currentTitleRef.current = null;
			currentSetRef.current = new Set();
			historyRef.current = [];
			selectedRef.current = null;
			setHistoryState([]);
			setSelectedState(null);
			setTimerRun(null);
			setTimerProgress(0);
		};
	}, [resultId]);

	/** Shows an entry in Spotlight and on the map; again to let it go. */
	const selectDistillation = useCallback(
		(id: string) => {
			if (selectedRef.current === id) {
				setSelected(null);
				store.setHighlightedNodeIds(new Set(), {
					isPreview: false,
					source: "history",
				});
				store.setHighlightedNodesDistance(new Map());
				return;
			}
			const entry = historyRef.current.find((item) => item.id === id);
			if (!entry) return;
			setSelected(id);
			highlightAsHistory(entry.nodeIds);
		},
		[highlightAsHistory, setSelected, store],
	);

	/** Lets the selected entry go without touching the map, as a click on a node does. */
	const deselect = useCallback(() => setSelected(null), [setSelected]);

	/** Asks again for an entry whose title failed. */
	const retry = useCallback(
		(id: string) => {
			const entry = historyRef.current.find((item) => item.id === id);
			if (!entry || entry.status !== "failed") return;
			startRequest(entry.nodeIds);
		},
		[startRequest],
	);

	return {
		deselect,
		history,
		isProcessing: history.some((entry) => entry.status === "pending"),
		retry,
		selectDistillation,
		selectedDistillationId,
		timerActive: timerRun !== null,
		timerProgress,
	};
}

export type SelectionTitleState = ReturnType<typeof useSelectionTitle>;
