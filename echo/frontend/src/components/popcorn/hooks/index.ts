import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { bff } from "@/lib/bff";

export type PopcornLoop = {
	id?: string;
	status: "active" | "paused" | "expired" | "stopped" | "ended" | string;
	expires_at?: string | null;
	cadence_minutes?: number | null;
	next_read_at?: string | null;
	last_run_started_at?: string | null;
	last_run_status?: "ok" | "no_op" | "error" | string | null;
	last_run_detail?: string | null;
};

export type PopcornTabs = {
	tensions: boolean;
	stakeholders: boolean;
};

export type PopcornVoicePreset = "gentle" | "plain" | "decisions";

export type PopcornVoice = {
	presets: PopcornVoicePreset[];
	note: string;
};

export type PopcornSettings = {
	title: string;
	client: string;
	tabs: PopcornTabs;
	public: boolean;
	show_qr: boolean;
	show_branding: boolean;
	voice: PopcornVoice;
};

export type PopcornVersion = {
	id: string;
	created_at: string;
	tick_kind?: string | null;
	detail?: string | null;
};

export type PopcornCounts = {
	conversations: number;
	conversations_read: number;
	reading?: number;
	phrases: number;
	quotes: number;
	tensions: number;
	stakeholders: number;
	analysis_updated_at?: string | null;
	run?: number | null;
};

export type PopcornDetail = {
	id: string;
	kind: "popcorn";
	project_id?: string | null;
	name: string;
	created_at?: string | null;
	updated_at?: string | null;
	settings: PopcornSettings;
	public_token?: string | null;
	loop?: PopcornLoop | null;
	counts: PopcornCounts;
};

export type PopcornSettingsPatch = Partial<
	Omit<PopcornSettings, "tabs" | "voice"> & {
		tabs: Partial<PopcornTabs>;
		voice: Partial<PopcornVoice>;
	}
>;

// Absolute so the same string works pasted into another site. Locally
// API_BASE_URL is the relative Vite proxy path, so it is resolved against
// the page origin.
const absoluteApiUrl = (path: string) =>
	new URL(`${API_BASE_URL}${path}`, window.location.origin).toString();

export const popcornHostViewUrl = (popcornId: string, versionId?: string) =>
	`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(popcornId)}/view/${
		versionId ? `?version=${encodeURIComponent(versionId)}` : ""
	}`;

// Upstream's fictional sample deck: the way to see popcorn before a real day.
export const popcornSampleViewUrl = (scale?: number) =>
	`${API_BASE_URL}/v2/bff/popcorn/sample/view/${scale ? `?scale=${scale}` : ""}`;

export const popcornPublicUrl = (token: string) =>
	absoluteApiUrl(`/v2/popcorn/public/${encodeURIComponent(token)}/`);

export const popcornEmbedSnippet = (token: string) =>
	`<iframe src="${popcornPublicUrl(token)}" title="popcorn" width="100%" height="720" style="border:0" allowfullscreen></iframe>`;

const projectKey = (projectId: string) => ["project", projectId, "popcorn"];

export const useProjectPopcorn = (projectId: string) =>
	useQuery({
		enabled: !!projectId,
		queryFn: async () => {
			const response = await bff.get<{ popcorn: PopcornDetail | null }>(
				"/popcorn",
				{ project_id: projectId },
			);
			return response.popcorn;
		},
		queryKey: projectKey(projectId),
		refetchInterval: (query) =>
			query.state.data?.loop?.status === "active" ? 15000 : false,
	});

export const useInvalidatePopcorn = (projectId: string) => {
	const queryClient = useQueryClient();
	return () =>
		queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
};

export const usePopcornVersions = (popcornId: string) =>
	useQuery({
		enabled: !!popcornId,
		queryFn: () =>
			bff.get<PopcornVersion[]>(
				`/popcorn/${encodeURIComponent(popcornId)}/versions`,
			),
		queryKey: ["popcorn", popcornId, "versions"],
		refetchInterval: 30000,
	});

export const useCreatePopcornMutation = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			title: string;
			client?: string;
			cadence_minutes?: number;
			expires_at: string;
			voice?: Partial<PopcornVoice>;
		}) =>
			bff.post<PopcornDetail>("/popcorn", {
				project_id: projectId,
				...payload,
			}),
		onError: () => toast.error(t`Could not start popcorn`),
		onSuccess: (detail) => {
			queryClient.setQueryData(projectKey(projectId), detail);
		},
	});
};

export const usePopcornSettingsMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: PopcornSettingsPatch) =>
			bff.patch<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/settings`,
				patch,
			),
		onError: () => toast.error(t`Could not save popcorn settings`),
		onSuccess: (detail) => {
			queryClient.setQueryData(projectKey(projectId), detail);
		},
	});
};

export const useRefreshPopcornMutation = (
	projectId: string,
	popcornId: string,
) => {
	const invalidate = useInvalidatePopcorn(projectId);
	return useMutation({
		mutationFn: () =>
			bff.post<{ tick: string }>(
				`/popcorn/${encodeURIComponent(popcornId)}/refresh`,
			),
		onError: (error: Error & { status?: number }) => {
			if (error.status === 429) {
				toast.info(t`Just refreshed. Give it a moment.`);
				return;
			}
			toast.error(t`Could not refresh popcorn`);
		},
		onSuccess: () => {
			toast.success(t`Reading the conversations again`);
			invalidate();
		},
	});
};

export const usePopcornLifecycleMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (action: "pause" | "resume" | "stop") =>
			bff.post<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/loop/${action}`,
			),
		onError: () => toast.error(t`Could not update popcorn`),
		onSuccess: (detail) => {
			queryClient.setQueryData(projectKey(projectId), detail);
		},
	});
};

export const usePopcornGoLiveMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			bff.post<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/loop/go-live`,
			),
		onError: () => toast.error(t`Could not bring popcorn back`),
		onSuccess: (detail) => {
			queryClient.setQueryData(projectKey(projectId), detail);
			toast.success(t`Live again for 8 hours`);
		},
	});
};

export const usePopcornLoopSettingsMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { cadence_minutes: number; expires_at: string }) =>
			bff.patch<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/loop`,
				payload,
			),
		onError: () => toast.error(t`Could not save popcorn schedule`),
		onSuccess: (detail) => {
			queryClient.setQueryData(projectKey(projectId), detail);
		},
	});
};
