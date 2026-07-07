import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { APP_ENVIRONMENT } from "@/config";
import { bff } from "@/lib/bff";
import { createFixtureCanvas, fixtureCanvasGenerations } from "../fixtures";

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
};

export type CanvasDetail = {
	id: string;
	name: string;
	kind: "canvas";
	project_id?: string | null;
	latest_generation?: CanvasGeneration | null;
	loop?: CanvasLoop | null;
	isDevFixture?: boolean;
};

type CanvasDetailResponse =
	| CanvasDetail
	| ({
			latest_generation?: CanvasGeneration | null;
			loop?: CanvasLoop | null;
	  } & Record<string, unknown>);

type BffError = Error & { status?: number };

const CANVAS_LATEST_POLL_MS = 30000;

function isMissingEndpoint(error: unknown): boolean {
	const bffError = error as BffError;
	const isLocalNetworkMiss =
		APP_ENVIRONMENT === "local" &&
		(error instanceof TypeError ||
			bffError?.message === "Failed to fetch" ||
			bffError?.message.includes("fetch failed"));
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
		id: String(report.id ?? canvasId),
		kind: "canvas",
		latest_generation:
			(response.latest_generation as CanvasGeneration | null | undefined) ?? null,
		loop: (response.loop as CanvasLoop | null | undefined) ?? null,
		name: String(report.name ?? report.title ?? t`Untitled canvas`),
		project_id:
			typeof report.project_id === "string" ? report.project_id : undefined,
	};
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
		if (isMissingEndpoint(error)) {
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
		if (isMissingEndpoint(error)) {
			return fixtureCanvasGenerations.slice(0, limit);
		}
		throw error;
	}
}

export function useCanvas(canvasId: string) {
	return useQuery({
		enabled: !!canvasId,
		queryFn: () => getCanvas(canvasId),
		queryKey: ["canvas", canvasId],
		refetchInterval: CANVAS_LATEST_POLL_MS,
	});
}

export function useCanvasGenerations(canvasId: string, limit = 8) {
	return useQuery({
		enabled: !!canvasId,
		queryFn: () => getCanvasGenerations(canvasId, limit),
		queryKey: ["canvas", canvasId, "generations", limit],
		refetchInterval: CANVAS_LATEST_POLL_MS,
	});
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
			if (isMissingEndpoint(error)) {
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
