import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "@/components/common/Toaster";
import { APP_ENVIRONMENT } from "@/config";
import { bff } from "@/lib/bff";
import {
	createFixtureCanvas,
	createFixtureProjectCanvases,
	fixtureCanvasGenerations,
} from "../fixtures";

export type CanvasGenerationStatus = "ok" | "no_op" | "error";

export type CanvasGeneration = {
	id: string;
	report_id: string;
	config_revision_id: string;
	content_html: string;
	status: CanvasGenerationStatus;
	tick_kind?: string | null;
	created_at: string;
};

export type CanvasLoop = {
	status: "active" | "paused" | "expired" | "stopped" | "ended" | string;
	expires_at?: string | null;
	cadence_minutes?: number | null;
	last_run_started_at?: string | null;
	last_run_status?: CanvasGenerationStatus | string | null;
	last_run_detail?: string | null;
};

export type CanvasListItem = {
	id: string;
	name: string;
	kind: "canvas";
	created_at: string;
	updated_at?: string | null;
	latest_generation_at?: string | null;
	project_id?: string | null;
	loop?: CanvasLoop | null;
	isDevFixture?: boolean;
};

export type CanvasConfig = {
	brief?: string | null;
	gather_spec?: Record<string, unknown> | null;
	tabs?: Array<Record<string, unknown>> | null;
	cadence_minutes?: number | null;
	created_at?: string | null;
};

export type CanvasDetail = {
	id: string;
	name: string;
	kind: "canvas";
	project_id?: string | null;
	created_from_chat_id?: string | null;
	updated_at?: string | null;
	config?: CanvasConfig | null;
	latest_generation?: CanvasGeneration | null;
	loop?: CanvasLoop | null;
	isDevFixture?: boolean;
};

export type CanvasProposal = {
	projectId: string;
	name: string;
	brief: string;
	gather_spec?: Record<string, unknown> | null;
	tabs?: Array<Record<string, unknown>> | null;
	cadence_minutes?: number | null;
	expires_at?: string | null;
	target_canvas_id?: string | null;
	target_canvas_name?: string | null;
	proposed_at?: string | null;
	created_from_chat_id?: string | null;
	applied_preview_html?: string | null;
};

type CanvasDetailResponse =
	| CanvasDetail
	| ({
			latest_generation?: CanvasGeneration | null;
			loop?: CanvasLoop | null;
	  } & Record<string, unknown>);

type BffError = Error & { status?: number };

const CANVAS_LATEST_POLL_MS = 30000;

function isFixtureEligibleMiss(error: unknown): boolean {
	const bffError = error as BffError;
	if (APP_ENVIRONMENT !== "local") return false;
	const isLocalNetworkMiss =
		error instanceof TypeError ||
		bffError?.message === "Failed to fetch" ||
		bffError?.message.includes("fetch failed");
	return (
		bffError?.status === 404 ||
		bffError?.message === "HTTP 404" ||
		isLocalNetworkMiss
	);
}

function normalizeCanvasResponse(
	canvasId: string,
	response: CanvasDetailResponse,
): CanvasDetail {
	const report = (
		"report" in response && typeof response.report === "object"
			? (response.report as Record<string, unknown>)
			: response
	) as Record<string, unknown>;
	return {
		config:
			report.config && typeof report.config === "object"
				? (report.config as CanvasConfig)
				: null,
		created_from_chat_id:
			typeof report.created_from_chat_id === "string"
				? report.created_from_chat_id
				: null,
		id: String(report.id ?? canvasId),
		kind: "canvas",
		latest_generation:
			(response.latest_generation as CanvasGeneration | null | undefined) ??
			null,
		loop: (response.loop as CanvasLoop | null | undefined) ?? null,
		name: String(report.name ?? report.title ?? t`Untitled canvas`),
		project_id:
			typeof report.project_id === "string" ? report.project_id : undefined,
		updated_at:
			typeof report.updated_at === "string" ? report.updated_at : null,
	};
}

function normalizeCanvasListItem(
	item: Record<string, unknown>,
): CanvasListItem {
	return {
		created_at: String(item.created_at ?? new Date().toISOString()),
		id: String(item.id ?? ""),
		kind: "canvas",
		latest_generation_at:
			typeof item.latest_generation_at === "string"
				? item.latest_generation_at
				: null,
		loop: (item.loop as CanvasLoop | null | undefined) ?? null,
		name: String(item.name ?? t`Untitled canvas`),
		project_id:
			typeof item.project_id === "string" ? item.project_id : undefined,
		updated_at: typeof item.updated_at === "string" ? item.updated_at : null,
	};
}

async function getProjectCanvases(
	projectId: string,
): Promise<CanvasListItem[]> {
	try {
		const response = await bff.get<Array<Record<string, unknown>>>(
			"/canvases",
			{
				project_id: projectId,
			},
		);
		return response.map(normalizeCanvasListItem).filter((canvas) => canvas.id);
	} catch (error) {
		if (isFixtureEligibleMiss(error)) {
			return createFixtureProjectCanvases(projectId).map((canvas) => ({
				...canvas,
				isDevFixture: true,
			}));
		}
		throw error;
	}
}

async function getCanvas(canvasId: string): Promise<CanvasDetail> {
	try {
		return normalizeCanvasResponse(
			canvasId,
			await bff.get<CanvasDetailResponse>(`/canvases/${canvasId}`),
		);
	} catch (error) {
		// DEV FIXTURE: Track A may not have the BFF route yet. A 404 keeps the
		// canvas demonstrable without pretending refresh is wired to a server.
		if (isFixtureEligibleMiss(error)) {
			return { ...createFixtureCanvas(canvasId), isDevFixture: true };
		}
		throw error;
	}
}

async function getCanvasGenerations(
	canvasId: string,
	limit: number,
): Promise<CanvasGeneration[]> {
	try {
		return await bff.get<CanvasGeneration[]>(
			`/canvases/${canvasId}/generations`,
			{ limit },
		);
	} catch (error) {
		// DEV FIXTURE: mirror the detail fallback until the BFF endpoint exists.
		if (isFixtureEligibleMiss(error)) {
			return fixtureCanvasGenerations.slice(0, limit);
		}
		throw error;
	}
}

export function useProjectCanvases(projectId: string) {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getProjectCanvases(projectId),
		queryKey: ["project", projectId, "canvases"],
		refetchInterval: CANVAS_LATEST_POLL_MS,
		refetchIntervalInBackground: true,
	});
}

export function useCanvas(canvasId: string) {
	return useQuery({
		enabled: !!canvasId,
		queryFn: () => getCanvas(canvasId),
		queryKey: ["canvas", canvasId],
		refetchInterval: CANVAS_LATEST_POLL_MS,
		refetchIntervalInBackground: true,
	});
}

export function useCanvasGenerations(canvasId: string, limit = 10) {
	return useQuery({
		enabled: !!canvasId,
		queryFn: () => getCanvasGenerations(canvasId, limit),
		queryKey: ["canvas", canvasId, "generations", limit],
		refetchInterval: CANVAS_LATEST_POLL_MS,
		refetchIntervalInBackground: true,
	});
}

export function useInvalidateCanvasQueries(canvasId: string) {
	const queryClient = useQueryClient();
	return useCallback(() => {
		if (!canvasId) return;
		queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] });
		queryClient.invalidateQueries({
			queryKey: ["canvas", canvasId, "generations"],
		});
		queryClient.invalidateQueries({ queryKey: ["project"] });
	}, [canvasId, queryClient]);
}

export function useRefreshCanvasMutation(canvasId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			bff.post<{ generation: "pending" }>(`/canvases/${canvasId}/refresh`),
		onError: (error: BffError) => {
			if (error.status === 429) {
				toast.message(t`Just refreshed. Give it a moment.`);
				return;
			}
			if (isFixtureEligibleMiss(error)) {
				toast.message(t`Refresh will work when the canvas service is ready.`);
				return;
			}
			toast.error(error.message || t`Could not refresh this canvas`);
		},
		onSuccess: () => {
			toast.success(t`Refresh started`);
			queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] });
		},
	});
}

export function usePreviewCanvasMutation() {
	return useMutation({
		mutationFn: async (proposal: CanvasProposal) => {
			try {
				return await bff.post<{ content_html: string }>("/canvases/preview", {
					brief: proposal.brief,
					gather_spec: proposal.gather_spec ?? undefined,
					tabs: proposal.tabs ?? undefined,
					project_id: proposal.projectId,
				});
			} catch (error) {
				if (isFixtureEligibleMiss(error)) {
					return { content_html: fixtureCanvasGenerations[0].content_html };
				}
				throw error;
			}
		},
	});
}

export function useCreateCanvasMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (proposal: CanvasProposal) =>
			bff.post<CanvasDetail>("/canvases", {
				applied_preview_html: proposal.applied_preview_html ?? undefined,
				brief: proposal.brief,
				cadence_minutes: proposal.cadence_minutes ?? undefined,
				created_from_chat_id: proposal.created_from_chat_id ?? undefined,
				expires_at: proposal.expires_at,
				gather_spec: proposal.gather_spec ?? undefined,
				tabs: proposal.tabs ?? undefined,
				name: proposal.name,
				project_id: proposal.projectId,
			}),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not create this canvas`);
		},
		onSuccess: (canvas, proposal) => {
			queryClient.invalidateQueries({
				queryKey: ["project", proposal.projectId, "canvases"],
			});
			queryClient.setQueryData(["canvas", canvas.id], canvas);
		},
	});
}

export function useUpdateCanvasMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (proposal: CanvasProposal & { target_canvas_id: string }) =>
			bff.patch<CanvasDetail>(`/canvases/${proposal.target_canvas_id}`, {
				applied_preview_html: proposal.applied_preview_html ?? undefined,
				brief: proposal.brief,
				cadence_minutes: proposal.cadence_minutes ?? undefined,
				created_from_chat_id: proposal.created_from_chat_id ?? undefined,
				gather_spec: proposal.gather_spec ?? undefined,
				tabs: proposal.tabs ?? undefined,
				name: proposal.name,
			}),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not update this canvas`);
		},
		onSuccess: (canvas, proposal) => {
			queryClient.invalidateQueries({
				queryKey: ["project", proposal.projectId, "canvases"],
			});
			queryClient.setQueryData(["canvas", canvas.id], canvas);
			queryClient.invalidateQueries({ queryKey: ["canvas", canvas.id] });
			queryClient.invalidateQueries({
				queryKey: ["canvas", canvas.id, "generations"],
			});
		},
	});
}

export function useCanvasLifecycleMutation(canvasId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (action: "pause" | "resume" | "stop") =>
			bff.post<CanvasLoop>(`/canvases/${canvasId}/loop/${action}`),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not update this canvas`);
		},
		onSuccess: (loop) => {
			queryClient.setQueryData<CanvasDetail | undefined>(
				["canvas", canvasId],
				(previous) => (previous ? { ...previous, loop } : previous),
			);
			queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] });
			queryClient.invalidateQueries({ queryKey: ["project"] });
		},
	});
}

export function useCanvasLoopSettingsMutation(canvasId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { cadence_minutes: number; expires_at: string }) =>
			bff.patch<CanvasLoop>(`/canvases/${canvasId}/loop`, payload),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not update this canvas`);
		},
		onSuccess: (loop) => {
			queryClient.setQueryData<CanvasDetail | undefined>(
				["canvas", canvasId],
				(previous) => (previous ? { ...previous, loop } : previous),
			);
			queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] });
			queryClient.invalidateQueries({ queryKey: ["project"] });
			toast.success(t`Canvas freshness updated`);
		},
	});
}
