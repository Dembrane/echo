import { t } from "@lingui/core/macro";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useServerEvents } from "@/hooks/useServerEvents";
import { bff } from "@/lib/bff";

export type AnalysisRecipe = {
	id: string;
	version: string;
	name: string;
	purpose: string;
	inputTypes: string[];
	outputTypes: string[];
	steps: Array<{
		key: string;
		kind: string;
		description: string;
		promptRef?: string | null;
		promptVersion?: string | null;
		checkVersion?: string | null;
	}>;
	validationRules: string[];
	parametersSchema?: {
		properties?: Record<string, Record<string, unknown>>;
		required?: string[];
	} | null;
	scopeKeyPattern: string;
};

export type AnalysisRun = {
	id: string;
	projectId: string;
	scopeId: string;
	scopeKey?: string | null;
	recipeId: string;
	recipeVersion: string;
	status: string;
	mode: string;
	progress: Record<string, unknown>;
	checks: Array<Record<string, unknown>>;
	error?: string | null;
	parameters: Record<string, unknown>;
	inputs: {
		fingerprint?: string | null;
		selectedRevisionIds: string[];
		revisions: number;
		dependencies: Record<string, unknown>;
	};
	output?: { objects: number; relations: number; contentHash?: string } | null;
	createdAt?: string | null;
	updatedAt?: string | null;
	completedAt?: string | null;
	steps?: Array<Record<string, unknown>>;
	definition?: Record<string, unknown>;
};

export type AnalysisObject = {
	objectId: string;
	revisionId: string;
	type: string;
	label?: string;
	payload?: Record<string, unknown>;
	detail?: unknown;
	attributes?: Record<string, unknown>;
	provenance?: Record<string, unknown>;
	missing?: boolean;
	membershipExcluded?: boolean;
	/**
	 * Why this finding needs the host's eye, where the server sorted for it
	 * (`sort=attention`, spec section 4). The list endpoint is growing the
	 * field; until it sends one, no row rises and the list keeps its order.
	 */
	attention?:
		| "new"
		| "one_conversation"
		| "one_quote"
		| "fact_check"
		| "reworded"
		| null;
	/** Who reworded it, for "Anna reworded this". */
	attentionActor?: string | null;
	/** When a host last reworded it, and who: the server's own reading. */
	lastAuthoredAt?: string | null;
	lastAuthoredBy?: string | null;
	/**
	 * Whether a host changed the words, whatever kind of change they called it:
	 * the public mark's own word. Absent where a reader (the map) carries no
	 * history, and then the row reads the provenance it has.
	 */
	edited?: boolean;
	/** What the finding rests on, counted by the server. */
	quoteCount?: number;
	conversationCount?: number;
	/**
	 * The conversation a finding rests on, where it rests on only one: the name
	 * the conversations table shows, so the meta line can say "1 quote from
	 * Marloes". For logged-in hosts only, and never in an audience payload.
	 */
	conversationName?: string | null;
	/** The latest fact-check verdict of this revision. */
	verdict?: string | null;
	/**
	 * What the host asking for the list thinks of this finding's quality: their
	 * own thumb, nobody else's, and never in an audience payload. Absent where a
	 * reader carries no feedback; null where this host has not rated it.
	 * `revisionId` is the wording they were rating.
	 */
	myFeedback?: {
		rating: "up" | "down";
		tags: string[];
		note?: string;
		revisionId: string;
	} | null;
};

export type AnalysisRevision = {
	revisionId: string;
	objectId: string;
	type: string;
	payload: Record<string, unknown>;
	revisionNumber: number;
	status: string;
	reason?: string | null;
	publishedAt?: string | null;
	membershipExcluded: boolean;
	provenance?: Record<string, unknown>;
	/** Who published it. Absent on revisions a run produced. */
	actorId?: string | null;
	/**
	 * What the host said they changed. The server is growing this field; old
	 * and generated revisions have none and read as "not recorded".
	 */
	changeKind?: string | null;
};

export type AnalysisObjectsPage = {
	snapshotId: string | null;
	counts: Record<string, number>;
	total: number;
	offset: number;
	limit: number;
	canEdit: boolean;
	items: AnalysisObject[];
};

export type AnalysisSource = {
	id: string;
	participant_name?: string | null;
	created_at?: string | null;
};

export const analysisKeys = {
	all: ["analysis"] as const,
	history: (projectId: string, objectId: string) =>
		[...analysisKeys.all, projectId, "object", objectId, "history"] as const,
	lastOpened: (projectId: string) =>
		[...analysisKeys.all, projectId, "last-opened"] as const,
	lineage: (snapshotId: string, revisionId: string) =>
		[
			...analysisKeys.all,
			"snapshot",
			snapshotId,
			revisionId,
			"lineage",
		] as const,
	objects: (
		projectId: string,
		type?: string,
		membership = "active",
		offset = 0,
	) =>
		[
			...analysisKeys.all,
			projectId,
			"objects",
			type ?? "all",
			membership,
			offset,
		] as const,
	recipes: () => [...analysisKeys.all, "recipes"] as const,
	run: (runId: string) => [...analysisKeys.all, "run", runId] as const,
	runs: (projectId: string) =>
		[...analysisKeys.all, projectId, "runs"] as const,
};

export function useAnalysisRecipes() {
	return useQuery({
		queryFn: async () =>
			(await bff.get<{ recipes: AnalysisRecipe[] }>("/analysis/recipes"))
				.recipes,
		queryKey: analysisKeys.recipes(),
		staleTime: 5 * 60_000,
	});
}

export function useAnalysisSources(projectId: string, enabled = true) {
	return useQuery({
		enabled: enabled && Boolean(projectId),
		queryFn: () =>
			bff.get<AnalysisSource[]>("/conversations", {
				limit: 1000,
				project_id: projectId,
				sort: "-created_at",
			}),
		queryKey: [...analysisKeys.all, projectId, "sources"],
		staleTime: 30_000,
	});
}

export function useAnalysisRuns(projectId: string) {
	return useQuery({
		enabled: Boolean(projectId),
		queryFn: () =>
			bff.get<{ total: number; canRun: boolean; runs: AnalysisRun[] }>(
				`/analysis/projects/${projectId}/runs`,
				{ limit: 100 },
			),
		queryKey: analysisKeys.runs(projectId),
	});
}

export function useAnalysisRun(runId?: string) {
	return useQuery({
		enabled: Boolean(runId),
		queryFn: async () =>
			(await bff.get<{ run: AnalysisRun }>(`/analysis/runs/${runId}`)).run,
		queryKey: analysisKeys.run(runId ?? ""),
	});
}

const ANALYSIS_EVENT_TYPES = [
	"queued",
	"progress",
	"ready",
	"superseded",
	"failed",
	"needs_review",
	"cancelled",
] as const;

export function useAnalysisEvents(projectId: string) {
	const queryClient = useQueryClient();
	const onEvent = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: [...analysisKeys.all, projectId],
		});
		void queryClient.invalidateQueries({
			predicate: (query) =>
				query.queryKey[0] === "analysis" && query.queryKey[1] === "run",
		});
	}, [projectId, queryClient]);
	useServerEvents(
		projectId
			? `${API_BASE_URL}/v2/bff/map/projects/${encodeURIComponent(projectId)}/events?runs=1`
			: null,
		ANALYSIS_EVENT_TYPES,
		onEvent,
	);
}

/** One request, one page of one kind. */
export const RESULTS_PAGE = 50;

/** The kinds the list groups, each paged on its own. */
export const RESULT_TYPES = [
	"popcorn",
	"tension",
	"stakeholder",
	"argument",
	"deduplicated_argument",
];

export type ResultsList = {
	items: AnalysisObject[];
	/** Per type, over the whole list: what a group header counts. */
	counts: Record<string, number>;
	total: number;
	canEdit: boolean;
	snapshotId: string | null;
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
	/** Types whose next page is on its way, for the quiet skeleton row. */
	loadingTypes: string[];
	/** Ask for the next page of these types. Nothing to fetch, nothing sent. */
	loadMore: (types: string[]) => void;
};

/**
 * The findings of a project, one page per kind, sorted by what needs this
 * host's eye.
 *
 * Every finding is reachable without a pager: a group asks for its next page
 * where it stands, and the pages of a kind stack in the order the server gave
 * them. Each page is its own query, so a save invalidates them all together
 * and the list comes back whole.
 */
export function useResultsList(
	projectId: string,
	{ membership = "active", type }: { membership?: string; type?: string } = {},
): ResultsList {
	const [pages, setPages] = useState<Record<string, number>>({});
	const types = type ? [type] : RESULT_TYPES;
	const wanted = types.flatMap((kind) =>
		Array.from({ length: pages[kind] ?? 1 }, (_, page) => ({ kind, page })),
	);
	const queries = useQueries({
		queries: wanted.map(({ kind, page }) => ({
			enabled: Boolean(projectId),
			queryFn: () =>
				bff.get<AnalysisObjectsPage>(
					`/analysis/projects/${projectId}/objects`,
					{
						limit: RESULTS_PAGE,
						membership,
						offset: page * RESULTS_PAGE,
						sort: "attention",
						type: kind,
					},
				),
			queryKey: analysisKeys.objects(
				projectId,
				kind,
				membership,
				page * RESULTS_PAGE,
			),
		})),
	});

	const items: AnalysisObject[] = [];
	const loaded: Record<string, number> = {};
	// A kind is drained when its last page came back short of a full one: the
	// counts say what a group holds, the pages say what is left to ask for.
	const drained: Record<string, boolean> = {};
	const loadingTypes: string[] = [];
	let counts: Record<string, number> = {};
	let canEdit = false;
	let snapshotId: string | null = null;
	let isLoading = false;
	let isError = false;
	wanted.forEach(({ kind, page }, index) => {
		const query = queries[index];
		if (!query) return;
		if (query.isError) isError = true;
		if (query.isPending) {
			if (page === 0) isLoading = true;
			else if (!loadingTypes.includes(kind)) loadingTypes.push(kind);
			return;
		}
		const data = query.data;
		if (!data) return;
		items.push(...data.items);
		loaded[kind] = (loaded[kind] ?? 0) + data.items.length;
		if (data.items.length < RESULTS_PAGE) drained[kind] = true;
		// Counts are the whole list's, whichever page answered.
		if (Object.keys(counts).length === 0) counts = data.counts ?? {};
		canEdit = canEdit || data.canEdit;
		snapshotId = snapshotId ?? data.snapshotId;
	});

	// Written afresh each render, because what has arrived is what decides
	// whether there is another page to ask for. The caller holds it in a ref.
	const loadMore = (asked: string[]) =>
		setPages((current) => {
			const next = { ...current };
			let grew = false;
			for (const kind of asked) {
				if (drained[kind]) continue;
				if ((loaded[kind] ?? 0) >= (counts[kind] ?? 0)) continue;
				// One page at a time: nothing is asked for twice while it is on
				// its way.
				if ((next[kind] ?? 1) > (loaded[kind] ?? 0) / RESULTS_PAGE) continue;
				next[kind] = (next[kind] ?? 1) + 1;
				grew = true;
			}
			return grew ? next : current;
		});

	const refetch = () => {
		for (const query of queries) void query.refetch();
	};

	return {
		canEdit,
		counts,
		isError,
		isLoading,
		items,
		loadingTypes,
		loadMore,
		refetch,
		snapshotId,
		total: types.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0),
	};
}

/**
 * A visit to the results list.
 *
 * The list is read against when this host last opened it, so the server can
 * say what is new. The mark is written when the host leaves the list, once, so
 * "new" holds for the whole visit and answers again on the next one. A host
 * who has never opened it has no mark, and then nothing is new.
 */
export function useResultsVisit(projectId: string) {
	const opened = useQuery({
		enabled: Boolean(projectId),
		queryFn: () =>
			bff.get<{ openedAt: string | null }>(
				`/analysis/projects/${projectId}/results/last-opened`,
			),
		queryKey: analysisKeys.lastOpened(projectId),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const marked = useRef(false);
	useEffect(() => {
		marked.current = false;
		return () => {
			if (!projectId || marked.current) return;
			marked.current = true;
			void bff
				.put(`/analysis/projects/${projectId}/results/last-opened`)
				// Nothing to say to the host: the worst of a lost mark is that a
				// finding reads as new once more.
				.catch(() => {});
		};
	}, [projectId]);
	return opened.data?.openedAt ?? null;
}

export function useAnalysisObjectHistory(projectId: string, objectId?: string) {
	return useQuery({
		enabled: Boolean(projectId && objectId),
		queryFn: () =>
			bff.get<{
				object: { id: string; type: string; revisionCount: number };
				revisions: AnalysisRevision[];
			}>(`/analysis/projects/${projectId}/objects/${objectId}/revisions`),
		queryKey: analysisKeys.history(projectId, objectId ?? ""),
	});
}

function useResultMutation(
	projectId: string,
	objectId: string,
	path: string,
	event: string,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: Record<string, unknown>) =>
			bff.post<{ revision: AnalysisRevision }>(
				`/analysis/projects/${projectId}/objects/${objectId}/${path}`,
				body,
			),
		// A 409 is the review conflict the drawer resolves on screen, with the
		// latest revision to load; a 422 is the reason the step asks for again,
		// in the line the host is reading. A toast would only talk over either.
		onError: (error: Error & { status?: number }) => {
			if (error.status === 409 || error.status === 422) return;
			toast.error(t`Could not save the change. Try again.`);
		},
		onSuccess: ({ revision }, body) => {
			// Ids and kinds only: never a payload field, a label or a review reason.
			posthog.capture(event, {
				object_id: objectId,
				project_id: projectId,
				result_type: revision.type,
				// Withdrawn and restored are one event with a flag, not two.
				...(typeof body.excluded === "boolean"
					? { excluded: body.excluded }
					: {}),
			});
			void queryClient.invalidateQueries({
				queryKey: analysisKeys.history(projectId, objectId),
			});
			void queryClient.invalidateQueries({
				queryKey: [...analysisKeys.all, projectId, "objects"],
			});
		},
	});
}

export function useEditAnalysisObject(projectId: string, objectId: string) {
	return useResultMutation(
		projectId,
		objectId,
		"revisions",
		"analysis_result_edited",
	);
}

export function useSetAnalysisMembership(projectId: string, objectId: string) {
	return useResultMutation(
		projectId,
		objectId,
		"membership",
		"analysis_result_membership_changed",
	);
}

export function useRollbackAnalysisObject(projectId: string, objectId: string) {
	return useResultMutation(
		projectId,
		objectId,
		"rollback",
		"analysis_result_rolled_back",
	);
}

export function useAnalysisLineage(
	snapshotId?: string | null,
	revisionId?: string,
) {
	return useQuery({
		enabled: Boolean(snapshotId && revisionId),
		queryFn: () =>
			bff.get<Record<string, unknown>>(
				`/analysis/snapshots/${snapshotId}/revisions/${revisionId}/lineage`,
			),
		queryKey: analysisKeys.lineage(snapshotId ?? "", revisionId ?? ""),
	});
}

export function useRequestAnalysisRun(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: {
			recipe_id: string;
			scope_key?: string;
			mode?: "refresh" | "regenerate" | "retry";
			retry_run_id?: string;
			parameters?: Record<string, unknown>;
		}) =>
			bff.post(`/analysis/projects/${projectId}/runs`, {
				...body,
				idempotency_key: crypto.randomUUID(),
			}),
		onError: () => toast.error(t`Could not start this run. Try again.`),
		onSuccess: (_data, body) => {
			// Ids and kinds only: no scope key, no parameters, no participant text.
			posthog.capture("analysis_run_requested", {
				mode: body.mode ?? "refresh",
				project_id: projectId,
				recipe_id: body.recipe_id,
			});
			void queryClient.invalidateQueries({
				queryKey: analysisKeys.runs(projectId),
			});
		},
	});
}

export function useCancelAnalysisRun(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (runId: string) => bff.post(`/analysis/runs/${runId}/cancel`),
		onError: () => toast.error(t`Could not stop this run. Try again.`),
		onSuccess: (_data, runId) => {
			// Ids only.
			posthog.capture("analysis_run_cancelled", {
				project_id: projectId,
				run_id: runId,
			});
			queryClient.invalidateQueries({ queryKey: analysisKeys.runs(projectId) });
			queryClient.invalidateQueries({ queryKey: analysisKeys.run(runId) });
		},
	});
}
