import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { attributeInputsOf, isFactCheckEligible } from "../attributes";
import type { FactCheckState, MapGraphNode } from "../types";
import {
	type FactCheckStates,
	type HttpError,
	mapKeys,
	putFactCheck,
	putStartedFactCheck,
	useCancelFactCheck,
	useMapFactChecks,
	useStartFactCheck,
} from "./index";

/** Start requests in flight at once, single and bulk alike. */
export const FACT_CHECK_CONCURRENCY = 4;
/** The pause after a refused (429) start; it doubles for each retry. */
export const RATE_LIMIT_BACKOFF_MS = 2000;
const RATE_LIMIT_BACKOFF_CAP_MS = 30_000;
/** Enough retries to outlast the API's one-minute window. */
export const RATE_LIMIT_MAX_RETRIES = 6;

export type UseMapFactCheckOptions = {
	resultId: string;
	/** Read-only roles can see verdicts but never start or cancel a check. */
	readOnly: boolean;
	/** Fixture mode: no requests; checks only change local state. */
	offline?: boolean;
	/** Fixture mode: states to start from. */
	initialStates?: FactCheckStates;
};

type Override = {
	state: FactCheckState;
	/**
	 * Set on errors: the server's state for the claim when the error was
	 * shown. The error stands only while the server still reports exactly that.
	 */
	server?: FactCheckState;
};

type StartJob = {
	resultId: string;
	nodeId: string;
	force: boolean;
	token: number;
	retries: number;
};

const IDLE: FactCheckState = { status: "idle" };

// A claim without a saved state is idle.
const sameState = (
	a: FactCheckState | undefined,
	b: FactCheckState | undefined,
) => JSON.stringify(a ?? IDLE) === JSON.stringify(b ?? IDLE);

const isCurrent = (
	tokens: ReadonlyMap<string, number>,
	nodeId: string,
	token: number,
) => tokens.get(nodeId) === token;

const backoffMs = (retries: number) =>
	Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** retries, RATE_LIMIT_BACKOFF_CAP_MS);

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
 * `processing` while a start is queued or in flight and `idle` while a cancel
 * is. The server dedupes checks across renderers, panels and tabs.
 *
 * Every start goes through one queue: at most four requests in flight, and a
 * refused (429) start pauses the queue and is retried with backoff.
 */
export function useMapFactCheck({
	resultId,
	readOnly,
	offline = false,
	initialStates,
}: UseMapFactCheckOptions) {
	const queryClient = useQueryClient();
	const query = useMapFactChecks(offline ? "" : resultId);
	const { mutateAsync: startCheck } = useStartFactCheck();
	const { mutateAsync: cancelCheck } = useCancelFactCheck();

	const [overrides, setOverrides] = useState<Record<string, Override>>({});
	// The latest local action per claim; an older response never overwrites it.
	const tokensRef = useRef(new Map<string, number>());
	const seqRef = useRef(0);
	const queueRef = useRef<StartJob[]>([]);
	const activeRef = useRef(0);
	const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Requests in flight for the previous result still settle and free their
	// slot; their tokens are gone, so they change nothing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the result id only
	useEffect(() => {
		tokensRef.current = new Map();
		queueRef.current = [];
		setOverrides({});
		return () => {
			if (pauseRef.current) clearTimeout(pauseRef.current);
			pauseRef.current = null;
		};
	}, [resultId]);

	const setOverride = useCallback(
		(nodeId: string, override: Override | null) =>
			setOverrides((previous) => {
				const next = { ...previous };
				if (override) {
					next[nodeId] = override;
				} else {
					delete next[nodeId];
				}
				return next;
			}),
		[],
	);

	const serverStates = offline ? initialStates : query.data;
	// Until the saved states arrive every claim looks idle. Nothing may start
	// in bulk before then, or a cold load re-checks claims that have a verdict.
	const ready = offline || query.data !== undefined;

	const states = useMemo<FactCheckStates>(() => {
		const merged: FactCheckStates = { ...(serverStates ?? {}) };
		for (const [nodeId, override] of Object.entries(overrides)) {
			if (
				override.server &&
				!sameState(serverStates?.[nodeId], override.server)
			)
				continue;
			merged[nodeId] = override.state;
		}
		return merged;
	}, [serverStates, overrides]);

	// An error the server has moved past is dropped for good.
	useEffect(() => {
		setOverrides((previous) => {
			let next: Record<string, Override> | null = null;
			for (const [nodeId, override] of Object.entries(previous)) {
				if (!override.server) continue;
				if (sameState(serverStates?.[nodeId], override.server)) continue;
				next ??= { ...previous };
				delete next[nodeId];
			}
			return next ?? previous;
		});
	}, [serverStates]);

	const pump = useCallback(() => {
		const send = async (job: StartJob) => {
			const { nodeId, token } = job;
			try {
				const state = await startCheck({
					force: job.force,
					nodeId,
					resultId: job.resultId,
				});
				if (!isCurrent(tokensRef.current, nodeId, token)) return;
				tokensRef.current.delete(nodeId);
				// An event refetch may already hold the finished check.
				putStartedFactCheck(queryClient, job.resultId, nodeId, state);
				setOverride(nodeId, null);
			} catch (error) {
				if (!isCurrent(tokensRef.current, nodeId, token)) return;
				const status = (error as HttpError | undefined)?.status;
				if (status === 429 && job.retries < RATE_LIMIT_MAX_RETRIES) {
					queueRef.current.unshift({ ...job, retries: job.retries + 1 });
					pause(backoffMs(job.retries));
					return;
				}
				tokensRef.current.delete(nodeId);
				setOverride(nodeId, {
					server:
						queryClient.getQueryData<FactCheckStates>(
							mapKeys.factChecks(job.resultId),
						)?.[nodeId] ?? IDLE,
					state: {
						at: new Date().toISOString(),
						message: startErrorMessage(error),
						status: "error",
					},
				});
			}
		};

		const pause = (ms: number) => {
			if (pauseRef.current) clearTimeout(pauseRef.current);
			pauseRef.current = setTimeout(() => {
				pauseRef.current = null;
				next();
			}, ms);
		};

		const next = () => {
			while (
				pauseRef.current === null &&
				activeRef.current < FACT_CHECK_CONCURRENCY
			) {
				const job = queueRef.current.shift();
				if (!job) return;
				// Cancelled or started again while it waited.
				if (!isCurrent(tokensRef.current, job.nodeId, job.token)) continue;
				activeRef.current += 1;
				void send(job).finally(() => {
					activeRef.current -= 1;
					next();
				});
			}
		};

		next();
	}, [queryClient, setOverride, startCheck]);

	const enqueue = useCallback(
		(
			nodeIds: ReadonlyArray<string>,
			options: { force?: boolean; front?: boolean },
		) => {
			if (readOnly || !resultId || nodeIds.length === 0) return;
			const jobs = nodeIds.map((nodeId): StartJob => {
				const token = ++seqRef.current;
				tokensRef.current.set(nodeId, token);
				return { force: !!options.force, nodeId, resultId, retries: 0, token };
			});
			const startedAt = new Date().toISOString();
			setOverrides((previous) => {
				const next = { ...previous };
				for (const { nodeId } of jobs) {
					next[nodeId] = { state: { startedAt, status: "processing" } };
				}
				return next;
			});
			if (offline) return;
			if (options.front) {
				queueRef.current.unshift(...jobs);
			} else {
				queueRef.current.push(...jobs);
			}
			pump();
		},
		[offline, pump, readOnly, resultId],
	);

	/** Starts one claim, ahead of any bulk starts still waiting. */
	const run = useCallback(
		(nodeId: string, options?: { force?: boolean }) =>
			enqueue([nodeId], { force: options?.force, front: true }),
		[enqueue],
	);

	/** Starts many claims, in order, through the same queue. */
	const runAll = useCallback(
		(nodeIds: ReadonlyArray<string>) => enqueue(nodeIds, {}),
		[enqueue],
	);

	const cancel = useCallback(
		async (nodeId: string) => {
			if (readOnly || !resultId) return;
			const token = ++seqRef.current;
			tokensRef.current.set(nodeId, token);
			setOverride(nodeId, { state: { status: "idle" } });
			if (offline) return;
			try {
				const state = await cancelCheck({ nodeId, resultId });
				if (!isCurrent(tokensRef.current, nodeId, token)) return;
				tokensRef.current.delete(nodeId);
				putFactCheck(queryClient, resultId, nodeId, state);
				setOverride(nodeId, null);
			} catch {
				if (!isCurrent(tokensRef.current, nodeId, token)) return;
				tokensRef.current.delete(nodeId);
				setOverride(nodeId, null);
				toast.error(t`The fact-check could not be cancelled.`);
				void queryClient.invalidateQueries({
					queryKey: mapKeys.factChecks(resultId),
				});
			}
		},
		[cancelCheck, offline, queryClient, readOnly, resultId, setOverride],
	);

	return {
		cancel,
		isLoading: query.isLoading,
		ready,
		run,
		runAll,
		states,
	};
}

export type MapFactCheck = ReturnType<typeof useMapFactCheck>;

/**
 * Eligible claims without a verdict that a check may start: idle or error.
 * Eligibility is the node's capability, not its type name.
 */
export const pendingClaimIds = (
	nodes: ReadonlyArray<MapGraphNode>,
	states: FactCheckStates,
): string[] =>
	nodes
		.filter((node) => {
			if (!isFactCheckEligible(attributeInputsOf(node.metadata))) return false;
			const status = states[node.id]?.status ?? "idle";
			return status === "idle" || status === "error";
		})
		.map((node) => node.id);

/**
 * "Auto fact-check new claims": once the saved states are known, starts idle
 * and error claims while enabled, at most once per claim per result for this
 * page session.
 */
export function useAutoFactCheck({
	enabled,
	ready,
	resultId,
	nodes,
	states,
	runAll,
}: {
	enabled: boolean;
	/** The saved states have loaded; before that every claim looks idle. */
	ready: boolean;
	resultId: string;
	nodes: ReadonlyArray<MapGraphNode>;
	states: FactCheckStates;
	runAll: (nodeIds: string[]) => unknown;
}) {
	const firedRef = useRef<{ resultId: string; ids: Set<string> }>({
		ids: new Set(),
		resultId,
	});

	useEffect(() => {
		if (firedRef.current.resultId !== resultId) {
			firedRef.current = { ids: new Set(), resultId };
		}
		if (!enabled || !ready) return;
		const fired = firedRef.current.ids;
		const ids = pendingClaimIds(nodes, states).filter((id) => !fired.has(id));
		if (ids.length === 0) return;
		for (const id of ids) fired.add(id);
		runAll(ids);
	}, [enabled, nodes, ready, resultId, runAll, states]);
}
