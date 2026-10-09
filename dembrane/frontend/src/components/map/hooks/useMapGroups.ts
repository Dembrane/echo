import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { centralityOrder } from "../graph/mst";
import { useMapInteractionStore } from "../state/interactionStore";
import type { Edge, MapGraphNode } from "../types";
import {
	createMapGroup,
	type HttpError,
	listMapGroups,
	type MapGroupDoc,
	type MapGroupMember,
	type MapGroupRequest,
	mapKeys,
} from "./index";

/** A settled highlight commits once the cursor circle has closed. */
export const DWELL_MS = 1500;
/** Smaller selections never start the circle. */
export const MIN_GROUP_NODES = 3;
/** How long the closed circle shows before the cursor ring clears. */
export const COMMIT_FLASH_MS = 600;
/** How often the list is read again while a group is being titled. */
export const POLL_MS = 1500;

export type DistillationStatus = "pending" | "done" | "failed" | "too-large";

/** A group as History and Spotlight show it. */
export type Distillation = {
	id: string;
	/** Result id plus the sorted node ids: one entry per selection. */
	key: string;
	status: DistillationStatus;
	/** Set once the title has arrived. */
	title?: string;
	/** Most central first, on the current map. */
	nodeIds: string[];
	createdAt: string;
};

export type GroupBackend = {
	list: (resultId: string) => Promise<MapGroupDoc[]>;
	create: (resultId: string, request: MapGroupRequest) => Promise<MapGroupDoc>;
};

export const serverGroupBackend: GroupBackend = {
	create: createMapGroup,
	list: listMapGroups,
};

/**
 * Groups kept in memory, for the synthetic map with no server behind it. The
 * same selection answers with the group it already has, as the server does.
 */
export function localGroupBackend(
	title: (count: number) => string,
	delayMs = 400,
): GroupBackend {
	const docs: MapGroupDoc[] = [];
	return {
		create: async (_resultId, request) => {
			const key = setKey(request.revisionIds);
			const existing = docs.find(
				(doc) => setKey(doc.members.map((m) => m.revisionId)) === key,
			);
			if (existing) return { ...existing };
			const doc: MapGroupDoc = {
				createdAt: new Date().toISOString(),
				error: null,
				id: `local-group-${docs.length + 1}`,
				members: request.revisionIds.map((revisionId) => ({
					objectId: null,
					revisionId,
					type: null,
				})),
				snapshotId: request.snapshotId,
				status: "pending",
				title: null,
			};
			docs.unshift(doc);
			setTimeout(() => {
				doc.status = "ready";
				doc.title = title(request.revisionIds.length);
			}, delayMs);
			return { ...doc };
		},
		list: async () => docs.map((doc) => ({ ...doc })),
	};
}

export type UseMapGroupsOptions = {
	resultId: string | null;
	/** The snapshot the nodes belong to; null for a legacy result. */
	snapshotId?: string | null;
	/** The placed nodes the renderers show. */
	nodes: ReadonlyArray<MapGraphNode>;
	/** The MST over those nodes, for centrality order. */
	edges: ReadonlyArray<Edge>;
	backend?: GroupBackend;
	/**
	 * False where groups are never shown (a viewer who is not signed in): no
	 * circle runs, nothing is listed and nothing is sent.
	 */
	enabled?: boolean;
	/** False where groups are shown but not made (no right to change the project). */
	canCommit?: boolean;
	/**
	 * The groups as read elsewhere (the room reads them with its map), in place
	 * of the project's list: nothing is fetched or polled for them.
	 */
	docs?: ReadonlyArray<MapGroupDoc>;
};

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
};

const setKey = (ids: Iterable<string>) => Array.from(ids).sort().join(",");

const STATUS: Record<MapGroupDoc["status"], DistillationStatus> = {
	failed: "failed",
	pending: "pending",
	ready: "done",
};

/**
 * Groups made by dwelling. The circle around the cursor is the only part that
 * can be taken back: a settled set of at least three nodes starts it, and any
 * move, a preview highlight or leaving the map before it closes takes it back
 * with nothing sent. Once it closes the selection is committed: the server
 * keeps it as a group, titles it on its worker and tells everyone on the
 * project, so it survives a reload and shows for others. Nothing the cursor
 * does next can undo it.
 *
 * A set that already is a group, or is on its way to becoming one, starts no
 * circle. The group this page committed last is selected (Spotlight shows it)
 * when its title lands, and takes over the highlight unless the cursor is
 * mid-circle on another set.
 */
export function useMapGroups({
	resultId,
	snapshotId = null,
	nodes,
	edges,
	backend = serverGroupBackend,
	enabled = true,
	canCommit = true,
	docs: givenDocs,
}: UseMapGroupsOptions) {
	const store = useMapInteractionStore();
	const queryClient = useQueryClient();
	const listKey = mapKeys.groups(resultId ?? "");

	const query = useQuery({
		enabled: enabled && !!resultId && !givenDocs,
		queryFn: () => backend.list(resultId as string),
		queryKey: listKey,
		refetchInterval: (q) =>
			q.state.data?.some((doc) => doc.status === "pending") ? POLL_MS : false,
		refetchOnWindowFocus: false,
	});
	const docs = givenDocs ?? query.data;

	// Commits the server has not answered, or refused: kept on this page only.
	const [local, setLocal] = useState<Distillation[]>([]);
	const [selectedDistillationId, setSelectedState] = useState<string | null>(
		null,
	);
	const [timerRun, setTimerRun] = useState<number | null>(null);
	const [timerProgress, setTimerProgress] = useState(0);

	const latestRef = useRef({
		backend,
		canCommit,
		edges,
		enabled,
		nodes,
		resultId,
		snapshotId,
	});
	latestRef.current = {
		backend,
		canCommit,
		edges,
		enabled,
		nodes,
		resultId,
		snapshotId,
	};

	const selectedRef = useRef<string | null>(null);
	const currentSetRef = useRef<ReadonlySet<string>>(new Set());
	const metaRef = useRef({ isPreview: false, updatedAt: 0 });
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const timerStartRef = useRef<number | null>(null);
	const timerSeqRef = useRef(0);
	const localSeqRef = useRef(0);
	/** The group this page committed last: only it may take over Spotlight. */
	const awaitingRef = useRef<string | null>(null);

	// Members to the nodes of the current map: by exact revision, or by object
	// where the map has moved on to a newer revision of it.
	const resolve = useMemo(() => {
		const byRevision = new Map<string, string>();
		const byObject = new Map<string, string>();
		for (const node of nodes) {
			byRevision.set(node.id, node.id);
			if (node.metadata.revisionId)
				byRevision.set(node.metadata.revisionId, node.id);
			if (node.metadata.objectId) byObject.set(node.metadata.objectId, node.id);
		}
		return (members: ReadonlyArray<MapGroupMember>): string[] => {
			const ids: string[] = [];
			for (const member of members) {
				const id =
					byRevision.get(member.revisionId) ??
					(member.objectId ? byObject.get(member.objectId) : undefined);
				if (id && !ids.includes(id)) ids.push(id);
			}
			return ids;
		};
	}, [nodes]);

	// A group none of whose members is on this map has nothing to show, and a
	// commit on its way stands in for the group it will answer with.
	const history = useMemo<Distillation[]>(() => {
		const id = resultId ?? "";
		const shadowed = new Set(local.map((entry) => entry.key));
		const server = (docs ?? [])
			.map(
				(doc): Distillation => ({
					createdAt: doc.createdAt ?? "",
					id: doc.id,
					key: `${id}::${setKey(resolve(doc.members))}`,
					nodeIds: resolve(doc.members),
					status: STATUS[doc.status],
					title: doc.title ?? undefined,
				}),
			)
			.filter((entry) => entry.nodeIds.length > 0 && !shadowed.has(entry.key));
		return [...local, ...server].sort((a, b) =>
			b.createdAt.localeCompare(a.createdAt),
		);
	}, [docs, local, resolve, resultId]);
	const historyRef = useRef(history);
	historyRef.current = history;

	const setSelected = useCallback((id: string | null) => {
		selectedRef.current = id;
		setSelectedState(id);
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

	// The group this page committed lands: Spotlight shows it, and the map
	// follows unless the cursor is mid-circle elsewhere.
	useEffect(() => {
		const id = awaitingRef.current;
		if (!id) return;
		const entry = history.find((item) => item.id === id);
		if (!entry || entry.status === "pending") return;
		awaitingRef.current = null;
		if (entry.status !== "done") return;
		setSelected(entry.id);
		const busy =
			timerStartRef.current !== null || store.getState().highlightIsPreview;
		if (!busy) highlightAsHistory(entry.nodeIds);
	}, [highlightAsHistory, history, setSelected, store]);

	const clearTimer = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
		// Only the running circle is taken back; a closed one keeps its flash.
		if (timerStartRef.current !== null) {
			timerStartRef.current = null;
			setTimerRun(null);
			setTimerProgress(0);
		}
	}, []);

	/** Commits nodes of the current map, most central first. */
	const send = useCallback(
		(nodeIds: string[]) => {
			const {
				backend: groups,
				nodes: graphNodes,
				resultId: id,
				snapshotId: snapshot,
			} = latestRef.current;
			if (!id) return;
			const byId = new Map(graphNodes.map((node) => [node.id, node] as const));
			const revisionIds = nodeIds.map(
				(nodeId) => byId.get(nodeId)?.metadata.revisionId || nodeId,
			);
			const key = `${id}::${setKey(nodeIds)}`;
			const localId = `local-${++localSeqRef.current}`;
			const pending: Distillation = {
				createdAt: new Date().toISOString(),
				id: localId,
				key,
				nodeIds,
				status: "pending",
			};
			setLocal((previous) => [
				pending,
				...previous.filter((entry) => entry.key !== key),
			]);
			awaitingRef.current = null;
			groups.create(id, { revisionIds, snapshotId: snapshot ?? null }).then(
				(doc) => {
					if (latestRef.current.resultId !== id) return;
					const listKey = mapKeys.groups(id);
					queryClient.setQueryData<MapGroupDoc[]>(listKey, (previous) => [
						doc,
						...(previous ?? []).filter((item) => item.id !== doc.id),
					]);
					setLocal((previous) =>
						previous.filter((entry) => entry.id !== localId),
					);
					awaitingRef.current = doc.id;
					void queryClient.invalidateQueries({ queryKey: listKey });
				},
				(reason: HttpError) => {
					if (latestRef.current.resultId !== id) return;
					setLocal((previous) =>
						previous.map((entry) =>
							entry.id === localId
								? {
										...entry,
										status: reason?.status === 413 ? "too-large" : "failed",
									}
								: entry,
						),
					);
				},
			);
		},
		[queryClient],
	);

	const commit = useCallback(
		(ids: ReadonlySet<string>) => {
			timeoutRef.current = null;
			timerStartRef.current = null;
			const { edges: treeEdges, nodes: graphNodes } = latestRef.current;
			const byId = new Map(graphNodes.map((node) => [node.id, node] as const));
			const eligible = Array.from(ids).filter((id) => byId.has(id));
			if (eligible.length < MIN_GROUP_NODES) {
				setTimerRun(null);
				setTimerProgress(0);
				return;
			}
			// The circle closed: show it whole for a moment, whatever comes next.
			setTimerProgress(1);
			if (flashRef.current) clearTimeout(flashRef.current);
			flashRef.current = setTimeout(() => {
				flashRef.current = null;
				if (timerStartRef.current !== null) return;
				setTimerRun(null);
				setTimerProgress(0);
			}, COMMIT_FLASH_MS);

			// Every settled node goes to the server; it refuses a selection it
			// cannot title whole rather than trimming it here.
			send(centralityOrder(eligible, graphNodes, treeEdges));
		},
		[send],
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

		// The cursor left: an open circle is taken back, a closed one is not.
		if (ids.size === 0) {
			clearTimer();
			if (currentSetRef.current.size !== 0) currentSetRef.current = new Set();
			return;
		}

		const setsChanged = !setsEqual(ids, currentSetRef.current);

		// Preview highlights (LocalMap while moving) never start the circle,
		// and a move takes back the one that is running.
		if (state.highlightIsPreview) {
			clearTimer();
			if (setsChanged) currentSetRef.current = ids;
			return;
		}

		if (!setsChanged && !previewCommitted) return;

		clearTimer();
		currentSetRef.current = ids;

		// History toggles highlight a group; they start nothing.
		if (state.highlightSource === "history") return;
		if (!latestRef.current.canCommit) return;

		// Already a group, or on its way to becoming one.
		const { resultId: id, nodes: graphNodes } = latestRef.current;
		const key = `${id ?? ""}::${setKey(ids)}`;
		if (
			historyRef.current.some(
				(entry) =>
					entry.key === key &&
					(entry.status === "done" || entry.status === "pending"),
			)
		)
			return;

		// A full circle is a promise: it is only drawn for a set that can be kept.
		const known = new Set(graphNodes.map((node) => node.id));
		let eligible = 0;
		for (const nodeId of ids) if (known.has(nodeId)) eligible += 1;
		if (eligible < MIN_GROUP_NODES) return;

		if (flashRef.current) {
			clearTimeout(flashRef.current);
			flashRef.current = null;
		}
		timerStartRef.current = Date.now();
		setTimerProgress(0);
		setTimerRun(++timerSeqRef.current);
		timeoutRef.current = setTimeout(() => commit(ids), DWELL_MS);
	}, [clearTimer, commit, store]);

	useEffect(() => {
		if (!enabled) return;
		return store.subscribe(handleChange);
	}, [enabled, store, handleChange]);

	// Switched off mid-circle: nothing may still be sent.
	useEffect(() => {
		if (enabled && canCommit) return;
		clearTimer();
	}, [canCommit, clearTimer, enabled]);

	// The circle around the cursor, closing over the dwell.
	useEffect(() => {
		if (timerRun === null) return;
		if (typeof requestAnimationFrame !== "function") return;
		let frame = 0;
		const tick = () => {
			const start = timerStartRef.current;
			if (start === null) return;
			const progress = Math.min((Date.now() - start) / DWELL_MS, 1);
			setTimerProgress(progress);
			if (progress < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [timerRun]);

	// A new result starts again from the server's list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the result id only
	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			if (flashRef.current) clearTimeout(flashRef.current);
			timeoutRef.current = null;
			flashRef.current = null;
			timerStartRef.current = null;
			awaitingRef.current = null;
			currentSetRef.current = new Set();
			selectedRef.current = null;
			setLocal([]);
			setSelectedState(null);
			setTimerRun(null);
			setTimerProgress(0);
		};
	}, [resultId]);

	/** Shows a group in Spotlight and on the map; again to let it go. */
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

	/** Lets the selected group go without touching the map, as a click on a node does. */
	const deselect = useCallback(() => setSelected(null), [setSelected]);

	/** Commits again a group whose run or commit failed. */
	const retry = useCallback(
		(id: string) => {
			if (!latestRef.current.canCommit) return;
			const entry = historyRef.current.find((item) => item.id === id);
			if (entry?.status === "failed") send(entry.nodeIds);
		},
		[send],
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

export type MapGroupsState = ReturnType<typeof useMapGroups>;
