import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback } from "react";
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

export function useAnalysisObjects(
	projectId: string,
	type?: string,
	membership = "active",
	offset = 0,
) {
	return useQuery({
		enabled: Boolean(projectId),
		queryFn: () =>
			bff.get<AnalysisObjectsPage>(`/analysis/projects/${projectId}/objects`, {
				limit: 100,
				membership,
				offset,
				type,
			}),
		queryKey: analysisKeys.objects(projectId, type, membership, offset),
	});
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
		// latest revision to load; a toast would only talk over it.
		onError: (error: Error & { status?: number }) => {
			if (error.status === 409) return;
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
