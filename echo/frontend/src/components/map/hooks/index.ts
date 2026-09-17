import { t } from "@lingui/core/macro";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { type ServerEvent, useServerEvents } from "@/hooks/useServerEvents";
import { bff } from "@/lib/bff";
import type { FactCheckState, MapKind, MapValence } from "../types";

// ---------------------------------------------------------------------------
// API shapes (server: dembrane/api/v2/bff/map.py)
// ---------------------------------------------------------------------------

export type MapEvidence = {
	conversation_id: string;
	label: string;
	created_at: string | null;
	quotes: string[];
};

export type MapArgument = {
	id: string;
	statement: string;
	kind: MapKind;
	valence: MapValence;
	claim_key: string | null;
	evidence: MapEvidence[];
	created_at: string | null;
	embedding: number[] | null;
};

export type MapConversation = {
	id: string;
	label: string;
	created_at: string | null;
};

export type MapStats = {
	conversations?: number;
	conversations_resumed?: number;
	candidates?: number;
	dropped_ungrounded?: number;
	arguments?: number;
	claims?: number;
	merged?: number;
	embeddings_new?: number;
	embeddings_reused?: number;
	seconds?: number;
	usage?: unknown;
};

export type MapResult = {
	id: string;
	status: "ready";
	created_at: string | null;
	completed_at: string | null;
	recipe_version: string | null;
	source_fingerprint: string | null;
	embedding: { model: string | null; dims: number | null; key: string | null };
	stats: MapStats;
	conversations: MapConversation[];
	arguments: MapArgument[];
	missing_embeddings: string[];
};

export type MapAttemptStatus = "queued" | "extracting" | "embedding" | "failed";

export type MapAttemptProgress = {
	stage?: string;
	conversations_total?: number;
	conversations_done?: number;
	conversations_failed?: number;
	conversations_resumed?: number;
	embeddings_total?: number;
	embeddings_done?: number;
	embeddings_reused?: number;
};

export type MapAttempt = {
	id: string;
	status: MapAttemptStatus;
	created_at: string | null;
	updated_at: string | null;
	completed_at: string | null;
	error: string | null;
	progress: MapAttemptProgress;
};

export type ProjectMapState = {
	current: MapResult | null;
	attempt: MapAttempt | null;
	// What a generation would read. Null when the count could not be made.
	source?: { conversations_with_transcripts: number | null } | null;
};

export type FactCheckStates = Record<string, FactCheckState>;

export type SelectionTitleResponse = { title: string; cached: boolean };

export type HttpError = Error & { status?: number };

export const isAttemptRunning = (attempt: MapAttempt | null | undefined) =>
	!!attempt && attempt.status !== "failed";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const mapKeys = {
	all: ["map"] as const,
	factChecks: (resultId: string) =>
		["map", "result", resultId, "fact-checks"] as const,
	project: (projectId: string) => ["map", "project", projectId] as const,
	results: ["map", "result"] as const,
};

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Saved map and generation
// ---------------------------------------------------------------------------

/** The project's current map revision and any newer attempt. */
export const useProjectMap = (projectId: string) =>
	useQuery({
		enabled: !!projectId,
		queryFn: () => bff.get<ProjectMapState>(`/map/projects/${enc(projectId)}`),
		queryKey: mapKeys.project(projectId),
		// A result carries every vector; the event stream says when to reload.
		refetchOnWindowFocus: false,
	});

const putAttempt = (
	queryClient: QueryClient,
	projectId: string,
	attempt: MapAttempt,
) =>
	queryClient.setQueryData<ProjectMapState>(
		mapKeys.project(projectId),
		(old) => ({ ...old, attempt, current: old?.current ?? null }),
	);

export const useGenerateMap = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			bff.post<{ attempt: MapAttempt }>(
				`/map/projects/${enc(projectId)}/generate`,
			),
		onError: (error: HttpError) => {
			if (error.status === 403) {
				toast.error(t`You do not have permission to generate a map.`);
				return;
			}
			if (error.status === 429) {
				toast.info(t`Many maps were started just now. Try again in a moment.`);
				return;
			}
			toast.error(t`The map could not be started.`);
		},
		onSuccess: ({ attempt }) => putAttempt(queryClient, projectId, attempt),
	});
};

// ---------------------------------------------------------------------------
// Fact-checks
// ---------------------------------------------------------------------------

export const useMapFactChecks = (resultId: string) =>
	useQuery({
		enabled: !!resultId,
		queryFn: async () =>
			(
				await bff.get<{ fact_checks: FactCheckStates }>(
					`/map/results/${enc(resultId)}/fact-checks`,
				)
			).fact_checks ?? {},
		queryKey: mapKeys.factChecks(resultId),
		refetchOnWindowFocus: false,
	});

export const putFactCheck = (
	queryClient: QueryClient,
	resultId: string,
	nodeId: string,
	state: FactCheckState,
) =>
	queryClient.setQueryData<FactCheckStates>(
		mapKeys.factChecks(resultId),
		(old) => ({ ...(old ?? {}), [nodeId]: state }),
	);

const factCheckTime = (state: FactCheckState | undefined): number | null => {
	if (!state) return null;
	const value =
		state.status === "processing"
			? state.startedAt
			: state.status === "done"
				? state.checkedAt
				: state.status === "error"
					? state.at
					: null;
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
};

/**
 * True when `cached` is a later server state than `response`, such as a check
 * that finished after the response's check started. A state without a time
 * is never newer.
 */
export const isNewerFactCheck = (
	cached: FactCheckState | undefined,
	response: FactCheckState,
): boolean => {
	const cachedAt = factCheckTime(cached);
	const responseAt = factCheckTime(response);
	if (cachedAt === null || responseAt === null) return false;
	if (cachedAt !== responseAt) return cachedAt > responseAt;
	// The same moment: a finished check outranks its own start.
	return cached?.status !== "processing" && response.status === "processing";
};

/** Writes a start response unless the cache already holds a later state. */
export const putStartedFactCheck = (
	queryClient: QueryClient,
	resultId: string,
	nodeId: string,
	state: FactCheckState,
) =>
	queryClient.setQueryData<FactCheckStates>(
		mapKeys.factChecks(resultId),
		(old) =>
			isNewerFactCheck(old?.[nodeId], state)
				? old
				: { ...(old ?? {}), [nodeId]: state },
	);

// The result id travels with each request, so a request queued for one
// result never goes out under another.
export const useStartFactCheck = () =>
	useMutation({
		mutationFn: ({
			resultId,
			nodeId,
			force,
		}: {
			resultId: string;
			nodeId: string;
			force?: boolean;
		}) =>
			bff.post<FactCheckState>(
				`/map/results/${enc(resultId)}/fact-checks/${enc(nodeId)}`,
				force ? { force: true } : {},
			),
	});

export const useCancelFactCheck = () =>
	useMutation({
		mutationFn: ({ resultId, nodeId }: { resultId: string; nodeId: string }) =>
			bff.delete<FactCheckState>(
				`/map/results/${enc(resultId)}/fact-checks/${enc(nodeId)}`,
			),
	});

// ---------------------------------------------------------------------------
// Selection titles
// ---------------------------------------------------------------------------

/**
 * Titles one selection. Plain function (not a hook) so each request can be
 * tied to the selection it was made for and aborted when that selection is
 * gone. Throws an HttpError carrying the status on failure.
 */
export async function requestSelectionTitle(
	resultId: string,
	nodeIds: string[],
	signal?: AbortSignal,
): Promise<SelectionTitleResponse> {
	const url = new URL(
		`${API_BASE_URL}/v2/bff/map/results/${enc(resultId)}/title`,
		typeof window !== "undefined" ? window.location.origin : "http://localhost",
	);
	const res = await fetch(url.toString(), {
		body: JSON.stringify({ node_ids: nodeIds }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
		signal,
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		const error = new Error(
			typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`,
		) as HttpError;
		error.status = res.status;
		throw error;
	}
	return (await res.json()) as SelectionTitleResponse;
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

const MAP_EVENT_TYPES = [
	"queued",
	"progress",
	"ready",
	"superseded",
	"failed",
	"fact_check",
] as const;

const PROGRESS_FIELDS = [
	"conversations_total",
	"conversations_done",
	"conversations_failed",
	"conversations_resumed",
	"embeddings_total",
	"embeddings_done",
	"embeddings_reused",
] as const;

/** Applies a progress event to the cached attempt; false when it does not match. */
export function applyProgressEvent(
	state: ProjectMapState | undefined,
	event: ServerEvent,
): ProjectMapState | null {
	const attempt = state?.attempt;
	if (!state || !attempt || attempt.id !== event.result_id) return null;
	const progress: MapAttemptProgress = { ...attempt.progress };
	if (typeof event.stage === "string") progress.stage = event.stage;
	for (const field of PROGRESS_FIELDS) {
		const value = event[field];
		if (typeof value === "number") progress[field] = value;
	}
	const status =
		event.stage === "extracting" || event.stage === "embedding"
			? event.stage
			: attempt.status;
	return { ...state, attempt: { ...attempt, progress, status } };
}

/** Fact-check events arriving within this window share one refetch. */
export const FACT_CHECK_REFETCH_DELAY_MS = 300;

/** Follows the project's map events and keeps the queries in step. */
export const useMapEvents = (projectId: string) => {
	const queryClient = useQueryClient();
	const factCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: cleanup keyed on the project id
	useEffect(
		() => () => {
			if (factCheckTimerRef.current) clearTimeout(factCheckTimerRef.current);
			factCheckTimerRef.current = null;
		},
		[projectId],
	);

	const onEvent = useCallback(
		(event: ServerEvent) => {
			switch (event.type) {
				case "connected":
					void queryClient.invalidateQueries({
						queryKey: mapKeys.project(projectId),
					});
					void queryClient.invalidateQueries({ queryKey: mapKeys.results });
					return;
				case "progress": {
					const key = mapKeys.project(projectId);
					const next = applyProgressEvent(
						queryClient.getQueryData<ProjectMapState>(key),
						event,
					);
					if (next) {
						queryClient.setQueryData(key, next);
					} else {
						void queryClient.invalidateQueries({ queryKey: key });
					}
					return;
				}
				case "fact_check":
					// A bulk run sends one event per claim. The first event of a
					// burst schedules a refetch of the current result's states;
					// the rest join it.
					if (factCheckTimerRef.current) return;
					factCheckTimerRef.current = setTimeout(() => {
						factCheckTimerRef.current = null;
						const resultId = queryClient.getQueryData<ProjectMapState>(
							mapKeys.project(projectId),
						)?.current?.id;
						if (!resultId) return;
						void queryClient.invalidateQueries({
							queryKey: mapKeys.factChecks(resultId),
						});
					}, FACT_CHECK_REFETCH_DELAY_MS);
					return;
				default:
					void queryClient.invalidateQueries({
						queryKey: mapKeys.project(projectId),
					});
			}
		},
		[projectId, queryClient],
	);

	useServerEvents(
		projectId
			? `${API_BASE_URL}/v2/bff/map/projects/${enc(projectId)}/events`
			: null,
		MAP_EVENT_TYPES,
		onEvent,
	);
};
