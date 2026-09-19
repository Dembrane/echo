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
/** The cursor arc grows to half a circle over the title delay. */
const TIMER_PROGRESS_CAP = 0.5;

export type Distillation = {
	id: string;
	/** Result id plus the sorted node ids: one entry per selection. */
	key: string;
	title: string;
	/** Most central first. */
	nodeIds: string[];
	createdAt: string;
};

export type SelectionTitleError = {
	kind: "failed" | "too-large";
	nodeIds: string[];
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

type Pending = { key: string; controller: AbortController };

/**
 * Titles the settled highlight, as DDW's visualizer did: a settled set that
 * holds for 1.5 s and has at least three nodes gets one title request; the
 * title joins the history, is selected, and takes over the highlight.
 *
 * Every request is tied to its selection. A response for a selection that is
 * no longer highlighted is discarded, a newer request is never hidden by an
 * older one finishing, and an emptied highlight (the cursor leaving both maps)
 * cancels what is pending. Identical selections reuse their title within the
 * session without a request.
 */
export function useSelectionTitle({
	resultId,
	snapshotId = null,
	nodes,
	edges,
	request = requestSelectionTitle,
}: UseSelectionTitleOptions) {
	const store = useMapInteractionStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setErrorState] = useState<SelectionTitleError | null>(null);
	const [history, setHistoryState] = useState<Distillation[]>([]);
	const [selectedDistillationId, setSelectedState] = useState<string | null>(
		null,
	);
	const [timerRun, setTimerRun] = useState<number | null>(null);
	const [timerProgress, setTimerProgress] = useState(0);

	const latestRef = useRef({ edges, nodes, request, resultId, snapshotId });
	latestRef.current = { edges, nodes, request, resultId, snapshotId };

	const historyRef = useRef<Distillation[]>([]);
	const selectedRef = useRef<string | null>(null);
	const errorRef = useRef<SelectionTitleError | null>(null);
	const currentTitleRef = useRef<{ key: string; nodeIds: Set<string> } | null>(
		null,
	);
	const currentSetRef = useRef<ReadonlySet<string>>(new Set());
	const metaRef = useRef({ isPreview: false, updatedAt: 0 });
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const timerStartRef = useRef<number | null>(null);
	const timerSeqRef = useRef(0);
	const pendingRef = useRef<Pending | null>(null);
	const cacheRef = useRef(new Map<string, string>());
	const historySeqRef = useRef(0);

	const setHistory = useCallback((next: Distillation[]) => {
		historyRef.current = next;
		setHistoryState(next);
	}, []);

	const setSelected = useCallback((id: string | null) => {
		selectedRef.current = id;
		setSelectedState(id);
	}, []);

	const setError = useCallback((next: SelectionTitleError | null) => {
		if (errorRef.current === next) return;
		errorRef.current = next;
		setErrorState(next);
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

	const abortPending = useCallback(() => {
		if (!pendingRef.current) return;
		pendingRef.current.controller.abort();
		pendingRef.current = null;
		setIsProcessing(false);
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

	const isHighlighted = useCallback(
		(nodeIds: string[]) =>
			setsEqual(store.getState().highlightedNodeIds, new Set(nodeIds)),
		[store],
	);

	const applyTitle = useCallback(
		(title: string, nodeIds: string[], key: string) => {
			currentTitleRef.current = { key, nodeIds: new Set(nodeIds) };
			const existing = historyRef.current.find((entry) => entry.key === key);
			const entry: Distillation = existing ?? {
				createdAt: new Date().toISOString(),
				id: `distillation-${++historySeqRef.current}`,
				key,
				nodeIds,
				title,
			};
			setHistory([
				entry,
				...historyRef.current.filter((item) => item.id !== entry.id),
			]);
			setSelected(entry.id);
			setError(null);
			highlightAsHistory(nodeIds);
		},
		[highlightAsHistory, setError, setHistory, setSelected],
	);

	const startRequest = useCallback(
		(nodeIds: string[]) => {
			const {
				request: send,
				resultId: id,
				snapshotId: snapshot,
				nodes: graphNodes,
			} = latestRef.current;
			if (!id) return;
			const key = selectionKey(id, nodeIds);
			const revisionOf = new Map(
				graphNodes.map((node) => [node.id, node.metadata.revisionId] as const),
			);
			// Titles are asked for exact revisions of one snapshot.
			const context: SelectionTitleContext = {
				revisionIds: nodeIds.map((nodeId) => revisionOf.get(nodeId) ?? nodeId),
				snapshotId: snapshot ?? null,
			};

			const cached = cacheRef.current.get(key);
			if (cached !== undefined) {
				abortPending();
				applyTitle(cached, nodeIds, key);
				return;
			}

			pendingRef.current?.controller.abort();
			const pending: Pending = { controller: new AbortController(), key };
			pendingRef.current = pending;
			setIsProcessing(true);
			setError(null);

			const settle = () => {
				if (pendingRef.current !== pending) return false;
				pendingRef.current = null;
				setIsProcessing(false);
				return true;
			};

			send(id, nodeIds, pending.controller.signal, context).then(
				(response) => {
					const title = response?.title?.trim() ?? "";
					if (title) cacheRef.current.set(key, title);
					// Superseded by a newer request: that one owns the spinner.
					if (!settle()) return;
					if (pending.controller.signal.aborted) return;
					// The selection moved on: never take over the new highlight.
					if (!isHighlighted(nodeIds)) return;
					if (!title) {
						setError({ kind: "failed", nodeIds });
						return;
					}
					applyTitle(title, nodeIds, key);
				},
				(reason: HttpError) => {
					if (!settle()) return;
					if (pending.controller.signal.aborted) return;
					if (!isHighlighted(nodeIds)) return;
					setError({
						kind: reason?.status === 413 ? "too-large" : "failed",
						nodeIds,
					});
				},
			);
		},
		[abortPending, applyTitle, isHighlighted, setError],
	);

	const fire = useCallback(
		(ids: ReadonlySet<string>) => {
			timeoutRef.current = null;
			timerStartRef.current = null;
			setTimerRun(null);
			setTimerProgress(0);

			const { edges: treeEdges, nodes: graphNodes } = latestRef.current;
			const known = new Set(graphNodes.map((node) => node.id));
			// Every settled node goes to the server; it refuses a selection it
			// cannot title whole rather than trimming it here.
			const eligible = Array.from(ids).filter((id) => known.has(id));
			if (eligible.length < MIN_TITLE_NODES) return;
			startRequest(centralityOrder(eligible, graphNodes, treeEdges));
		},
		[startRequest],
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
			abortPending();
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

		// History toggles highlight a titled set; they start nothing.
		if (state.highlightSource === "history") {
			currentSetRef.current = ids;
			return;
		}

		// Back on the set that already has the current title.
		const currentTitle = currentTitleRef.current;
		if (currentTitle && setsEqual(ids, currentTitle.nodeIds)) {
			currentSetRef.current = ids;
			return;
		}

		// Already asking for exactly this set.
		const { resultId: id } = latestRef.current;
		if (
			id &&
			pendingRef.current &&
			pendingRef.current.key === selectionKey(id, ids)
		) {
			currentSetRef.current = ids;
			return;
		}

		currentTitleRef.current = null;
		setSelected(null);
		abortPending();
		setError(null);
		currentSetRef.current = ids;

		timerStartRef.current = Date.now();
		setTimerRun(++timerSeqRef.current);
		timeoutRef.current = setTimeout(() => fire(ids), TITLE_DELAY_MS);
	}, [abortPending, clearTimer, fire, setError, setSelected, store]);

	useEffect(() => store.subscribe(handleChange), [store, handleChange]);

	// Cursor arc progress, capped at half a circle.
	useEffect(() => {
		if (timerRun === null) return;
		if (typeof requestAnimationFrame !== "function") return;
		let frame = 0;
		const tick = () => {
			const start = timerStartRef.current;
			if (start === null) return;
			const progress = Math.min(
				(Date.now() - start) / TITLE_DELAY_MS,
				TIMER_PROGRESS_CAP,
			);
			setTimerProgress(progress);
			if (progress < TIMER_PROGRESS_CAP) frame = requestAnimationFrame(tick);
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
			pendingRef.current?.controller.abort();
			pendingRef.current = null;
			currentTitleRef.current = null;
			currentSetRef.current = new Set();
			historyRef.current = [];
			selectedRef.current = null;
			errorRef.current = null;
			setHistoryState([]);
			setSelectedState(null);
			setErrorState(null);
			setIsProcessing(false);
			setTimerRun(null);
			setTimerProgress(0);
		};
	}, [resultId]);

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

	/** Asks again for the selection whose title failed. */
	const retry = useCallback(() => {
		const failed = errorRef.current;
		if (!failed || failed.kind !== "failed") return;
		clearTimer();
		currentTitleRef.current = null;
		setSelected(null);
		// Make the failed set the settled highlight again, so its answer is
		// still current when it lands.
		highlightAsHistory(failed.nodeIds);
		startRequest(failed.nodeIds);
	}, [clearTimer, highlightAsHistory, setSelected, startRequest]);

	return {
		error,
		history,
		isProcessing,
		retry,
		selectDistillation,
		selectedDistillationId,
		timerActive: timerRun !== null,
		timerProgress,
	};
}

export type SelectionTitleState = ReturnType<typeof useSelectionTitle>;
