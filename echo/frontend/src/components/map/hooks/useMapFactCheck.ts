import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/common/Toaster";
import type { FactCheckState, MapGraphNode } from "../types";
import {
	type FactCheckStates,
	type HttpError,
	mapKeys,
	putFactCheck,
	useCancelFactCheck,
	useMapFactChecks,
	useStartFactCheck,
} from "./index";

export type UseMapFactCheckOptions = {
	resultId: string;
	/** Read-only roles can see verdicts but never start or cancel a check. */
	readOnly: boolean;
	/** Fixture mode: no requests; checks only change local state. */
	offline?: boolean;
	/** Fixture mode: states to start from. */
	initialStates?: FactCheckStates;
};

const startErrorMessage = (error: unknown) => {
	const status = (error as HttpError | undefined)?.status;
	if (status === 403)
		return t`You do not have permission to fact-check claims.`;
	if (status === 429) {
		return t`Many fact-checks were started just now. Try again in a moment.`;
	}
	return t`The fact-check could not be started.`;
};

/**
 * Fact-check state per claim for one result, from the server, with a local
 * `processing` while a start request is in flight and `idle` while a cancel
 * is. The server dedupes checks across renderers, panels and tabs.
 */
export function useMapFactCheck({
	resultId,
	readOnly,
	offline = false,
	initialStates,
}: UseMapFactCheckOptions) {
	const queryClient = useQueryClient();
	const query = useMapFactChecks(offline ? "" : resultId);
	const { mutateAsync: startCheck } = useStartFactCheck(resultId);
	const { mutateAsync: cancelCheck } = useCancelFactCheck(resultId);

	const [overrides, setOverrides] = useState<FactCheckStates>({});
	// The latest local action per claim; an older response never overwrites it.
	const tokensRef = useRef(new Map<string, number>());
	const seqRef = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the result id only
	useEffect(() => {
		tokensRef.current = new Map();
		setOverrides({});
	}, [resultId]);

	const setOverride = useCallback(
		(nodeId: string, state: FactCheckState | null) =>
			setOverrides((previous) => {
				const next = { ...previous };
				if (state) {
					next[nodeId] = state;
				} else {
					delete next[nodeId];
				}
				return next;
			}),
		[],
	);

	const serverStates = offline ? initialStates : query.data;
	const states = useMemo<FactCheckStates>(
		() => ({ ...(serverStates ?? {}), ...overrides }),
		[serverStates, overrides],
	);

	const claim = (nodeId: string) => {
		const token = ++seqRef.current;
		tokensRef.current.set(nodeId, token);
		return () => {
			if (tokensRef.current.get(nodeId) !== token) return false;
			tokensRef.current.delete(nodeId);
			return true;
		};
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: claim only touches refs
	const run = useCallback(
		async (nodeId: string, options?: { force?: boolean }) => {
			if (readOnly || !resultId) return;
			const isCurrent = claim(nodeId);
			setOverride(nodeId, {
				startedAt: new Date().toISOString(),
				status: "processing",
			});
			if (offline) return;
			try {
				const state = await startCheck({ force: options?.force, nodeId });
				if (!isCurrent()) return;
				putFactCheck(queryClient, resultId, nodeId, state);
				setOverride(nodeId, null);
			} catch (error) {
				if (!isCurrent()) return;
				setOverride(nodeId, {
					at: new Date().toISOString(),
					message: startErrorMessage(error),
					status: "error",
				});
			}
		},
		[offline, queryClient, readOnly, resultId, setOverride, startCheck],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: claim only touches refs
	const cancel = useCallback(
		async (nodeId: string) => {
			if (readOnly || !resultId) return;
			const isCurrent = claim(nodeId);
			setOverride(nodeId, { status: "idle" });
			if (offline) return;
			try {
				const state = await cancelCheck({ nodeId });
				if (!isCurrent()) return;
				putFactCheck(queryClient, resultId, nodeId, state);
				setOverride(nodeId, null);
			} catch {
				if (!isCurrent()) return;
				setOverride(nodeId, null);
				toast.error(t`The fact-check could not be cancelled.`);
				void queryClient.invalidateQueries({
					queryKey: mapKeys.factChecks(resultId),
				});
			}
		},
		[cancelCheck, offline, queryClient, readOnly, resultId, setOverride],
	);

	return { cancel, isLoading: query.isLoading, run, states };
}

export type MapFactCheck = ReturnType<typeof useMapFactCheck>;

/** Claims without a verdict that a check may start: idle or error. */
export const pendingClaimIds = (
	nodes: ReadonlyArray<MapGraphNode>,
	states: FactCheckStates,
): string[] =>
	nodes
		.filter((node) => {
			if (node.metadata.kind !== "claim") return false;
			const status = states[node.id]?.status ?? "idle";
			return status === "idle" || status === "error";
		})
		.map((node) => node.id);

/**
 * "Auto fact-check new claims": starts idle and error claims while enabled,
 * at most once per claim per result for this page session.
 */
export function useAutoFactCheck({
	enabled,
	resultId,
	nodes,
	states,
	run,
}: {
	enabled: boolean;
	resultId: string;
	nodes: ReadonlyArray<MapGraphNode>;
	states: FactCheckStates;
	run: (nodeId: string) => unknown;
}) {
	const firedRef = useRef<{ resultId: string; ids: Set<string> }>({
		ids: new Set(),
		resultId,
	});

	useEffect(() => {
		if (firedRef.current.resultId !== resultId) {
			firedRef.current = { ids: new Set(), resultId };
		}
		if (!enabled) return;
		for (const id of pendingClaimIds(nodes, states)) {
			if (firedRef.current.ids.has(id)) continue;
			firedRef.current.ids.add(id);
			void run(id);
		}
	}, [enabled, nodes, resultId, run, states]);
}
