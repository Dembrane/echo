import { t } from "@lingui/core/macro";
import {
	keepPreviousData,
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
import { budgetRequestParams, type CustomBudgets } from "../budgets";
import type {
	FactCheckState,
	MapEpistemicKind,
	MapKind,
	MapValence,
	ObjectType,
} from "../types";

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
	/** Snapshot identity included by the project summary compatibility payload. */
	snapshot_id?: string | null;
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

// Map payload v2 (docs/superpowers/plans/2026-09-15-recipes-mixed-map-plan.md).

export type MapStaleRef = {
	revisionId: string;
	reason?: string;
	[key: string]: unknown;
};

export type MapPayloadBudgets = {
	nodeLimit: number;
	edgeLimit: number;
	defaults: { nodeLimit: number; edgeLimit: number };
	ceilings?: { nodeLimit?: number; edgeLimit?: number };
};

export type MapProvenance = {
	runId: string;
	recipeId?: string;
	recipeVersion?: string;
	origin: "generated" | "authored" | "imported";
};

export type MapPayloadNode = {
	objectId: string;
	revisionId: string;
	type: ObjectType;
	label: string;
	/** Type-specific projection; parsed defensively by the adapter. */
	detail: unknown;
	attributes: { valence?: MapValence; epistemicKind?: MapEpistemicKind };
	factCheck?: {
		eligible: boolean;
		claimKey?: string;
		assessmentRevisionId?: string;
	};
	provenance: MapProvenance;
	/**
	 * Palette slots of the conversations behind this node, one entry per
	 * contributing member. The room's projection carries these in place of the
	 * conversations themselves, so the map can colour by conversation without
	 * being told which conversation it is.
	 */
	conversations?: number[];
	/** Null: listed as unplaced. */
	embedding: number[] | null;
};

export type MapPayloadRelation = {
	id: string;
	type: string;
	from: string;
	to: string;
	basis: "extracted" | "inferred" | "authored";
};

export type MapPayloadV2 = {
	version: 2;
	snapshot: {
		id: string;
		createdAt: string;
		parentId: string | null;
		stale: MapStaleRef[];
	};
	budgets: MapPayloadBudgets;
	/** In the snapshot, before filtering. */
	counts: Record<ObjectType, number>;
	scope: { types: ObjectType[]; resultScope?: string };
	/** True: nodes and vectors omitted. */
	overBudget: boolean;
	embedding: { key: string; model: string; dims: number };
	nodes: MapPayloadNode[];
	/**
	 * What to call the conversation in a palette slot, by slot. The room's
	 * projection carries it only where the presentation's names-on-the-legend
	 * setting is on; without it the room numbers the conversations itself. The
	 * host payload leaves it out: its evidence names them already.
	 */
	conversationNames?: Record<string, string>;
	/** Endpoints are revision ids. */
	relations: MapPayloadRelation[];
	/** Revision ids without vectors. */
	unplaced: string[];
	/**
	 * Proposed: objects outside `nodes` that relations point at, so the
	 * inspector can name them and offer to reveal their type.
	 */
	related?: Array<{
		objectId: string;
		revisionId: string;
		type: ObjectType;
		label: string;
	}>;
};

/** What the graph endpoint returns: v2, or a legacy v1 result. */
export type MapGraphResponse = MapPayloadV2 | MapResult;

export type MapGraphParams = CustomBudgets & {
	/** Null leaves the type selection to the server. */
	types: ObjectType[] | null;
	scope: string | null;
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
	current: MapGraphResponse | null;
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
	// Under the project key, so a project invalidation reloads the graph too.
	graph: (projectId: string, params: MapGraphParams) =>
		[
			"map",
			"project",
			projectId,
			"graph",
			{
				edgeLimit: params.edgeLimit,
				nodeLimit: params.nodeLimit,
				scope: params.scope,
				types: params.types ? [...params.types].sort() : null,
			},
		] as const,
	project: (projectId: string) => ["map", "project", projectId] as const,
	projectLegacy: (projectId: string) =>
		["map", "project", projectId, "legacy"] as const,
	results: ["map", "result"] as const,
};

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Saved map and generation
// ---------------------------------------------------------------------------

/** The project's current map revision and any newer attempt. */
export const useProjectMap = (
	projectId: string,
	{ enabled = true }: { enabled?: boolean } = {},
) =>
	useQuery({
		enabled: enabled && !!projectId,
		queryFn: () => bff.get<ProjectMapState>(`/map/projects/${enc(projectId)}`),
		queryKey: mapKeys.projectLegacy(projectId),
		// A result carries every vector; the event stream says when to reload.
		refetchOnWindowFocus: false,
	});

/** Project state without graph vectors, used before large-map admission. */
export const useProjectMapSummary = (projectId: string) =>
	useQuery({
		enabled: !!projectId,
		queryFn: () =>
			bff.get<ProjectMapState>(`/map/projects/${enc(projectId)}`, {
				metadata_only: true,
			}),
		queryKey: mapKeys.project(projectId),
		refetchOnWindowFocus: false,
	});

/** Query parameters of the graph request. */
export const mapGraphRequestParams = (params: MapGraphParams) => ({
	...budgetRequestParams(params),
	...(params.scope ? { scope: params.scope } : {}),
	// An empty list is sent as an empty value: no types selected.
	...(params.types ? { types: params.types.join(",") } : {}),
});

/**
 * The bounded graph for one type selection, scope and budget. The server
 * counts before it loads vectors and omits nodes when the scope is over
 * budget. The previous graph stays while a new scope loads.
 *
 * Resolves to null when the server has no graph endpoint yet (404), so the
 * page can fall back to the project's legacy result.
 */
export const useMapGraph = (
	projectId: string,
	params: MapGraphParams,
	{ enabled = true }: { enabled?: boolean } = {},
) =>
	useQuery({
		enabled: enabled && !!projectId,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<MapGraphResponse | null> => {
			try {
				return await bff.get<MapGraphResponse>(
					`/map/projects/${enc(projectId)}/graph`,
					mapGraphRequestParams(params),
				);
			} catch (error) {
				// TODO(lead): drop this fallback once the v2 graph endpoint ships.
				if ((error as HttpError)?.status === 404) return null;
				throw error;
			}
		},
		queryKey: mapKeys.graph(projectId, params),
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
export type SelectionTitleContext = {
	/** The snapshot the selection was made in; null for a legacy result. */
	snapshotId?: string | null;
	/** The exact revisions selected, most central first. */
	revisionIds?: string[];
};

export async function requestSelectionTitle(
	resultId: string,
	nodeIds: string[],
	signal?: AbortSignal,
	context?: SelectionTitleContext,
): Promise<SelectionTitleResponse> {
	const url = new URL(
		`${API_BASE_URL}/v2/bff/map/results/${enc(resultId)}/title`,
		typeof window !== "undefined" ? window.location.origin : "http://localhost",
	);
	const res = await fetch(url.toString(), {
		body: JSON.stringify({
			node_ids: nodeIds,
			...(context?.snapshotId ? { snapshot_id: context.snapshotId } : {}),
			...(context?.revisionIds ? { revision_ids: context.revisionIds } : {}),
		}),
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
	"needs_review",
	"cancelled",
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

/** The id fact-checks are keyed under: a v2 snapshot id or a v1 result id. */
const currentResultId = (current: MapGraphResponse): string | null =>
	"version" in current && current.version === 2
		? (current.snapshot?.id ?? null)
		: ((current as MapResult).id ?? null);

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
						const current = queryClient.getQueryData<ProjectMapState>(
							mapKeys.project(projectId),
						)?.current;
						const resultId = current ? currentResultId(current) : null;
						if (!resultId) {
							// The graph comes from its own query: refresh every
							// result's states rather than miss the one on screen.
							void queryClient.invalidateQueries({
								predicate: (query) =>
									query.queryKey[0] === "map" &&
									query.queryKey[1] === "result" &&
									query.queryKey[3] === "fact-checks",
							});
							return;
						}
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
			? `${API_BASE_URL}/v2/bff/map/projects/${enc(projectId)}/events?runs=1`
			: null,
		MAP_EVENT_TYPES,
		onEvent,
	);
};
