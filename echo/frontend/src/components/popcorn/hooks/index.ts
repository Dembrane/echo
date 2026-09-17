import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { bff } from "@/lib/bff";

export type PopcornLoop = {
	id?: string;
	status: string;
	// manual: nothing scheduled, Refresh reads once. live: a read every two
	// minutes until expires_at, then back to manual.
	mode: "manual" | "live";
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

export type PopcornIntro = {
	enabled: boolean;
	title: string;
	subtitle: string;
};

// A screen before the countdown, with an optional follow-up screen.
export type PopcornDisclosure = {
	enabled: boolean;
	text: string;
	invitation_title: string;
	invitation_text: string;
};

// The bar above every tab of the screen.
export type PopcornNotice = { enabled: boolean; text: string };

// The screen that explains what happens to the data. Its words follow the
// project's anonymisation and legal basis.
export type PopcornData = { enabled: boolean };

export type PopcornLanguageCode =
	| "en"
	| "nl"
	| "de"
	| "fr"
	| "es"
	| "it"
	| "uk"
	| "cs";

// The screen's own language ("auto" follows the project) and the language the
// results are translated into ("" keeps them as spoken).
export type PopcornLanguage = {
	ui: "auto" | PopcornLanguageCode;
	translate_to: "" | PopcornLanguageCode;
};

export type PopcornSettings = {
	intro: PopcornIntro;
	disclosure: PopcornDisclosure;
	notice: PopcornNotice;
	data: PopcornData;
	language?: PopcornLanguage;
	title: string;
	client: string;
	tabs: PopcornTabs;
	public: boolean;
	show_qr: boolean;
	show_branding: boolean;
	// What the room's legend calls a conversation: the name typed on the
	// phone, or a number.
	public_labels: "names" | "neutral";
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
	validated?: number;
	held_back?: number;
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
	// A synthetic demo always shows its disclosure and notice.
	synthetic?: boolean;
	public_token?: string | null;
	loop?: PopcornLoop | null;
	counts: PopcornCounts;
};

// What a first read would find, before a session exists.
export type PopcornReadiness = { conversations: number; words: number };

export type PopcornProject = {
	popcorn: PopcornDetail | null;
	readiness?: PopcornReadiness;
};

export type LiveHours = 1 | 8 | 24;

export type PopcornSettingsPatch = Partial<
	Omit<
		PopcornSettings,
		"tabs" | "voice" | "intro" | "disclosure" | "notice" | "data" | "language"
	> & {
		intro: Partial<PopcornIntro>;
		disclosure: Partial<PopcornDisclosure>;
		notice: Partial<PopcornNotice>;
		data: Partial<PopcornData>;
		language: Partial<PopcornLanguage>;
		tabs: Partial<PopcornTabs>;
		voice: Partial<PopcornVoice>;
	}
>;

// Absolute so the same string works pasted into another site. Locally
// API_BASE_URL is the relative Vite proxy path, so it is resolved against
// the page origin.
const absoluteApiUrl = (path: string) =>
	new URL(`${API_BASE_URL}${path}`, window.location.origin).toString();

// The deck full screen in its own tab: the room's view, no host affordance.
// A saved run replays the same way.
export const popcornPresenterUrl = (popcornId: string, versionId?: string) =>
	`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(popcornId)}/view/?present=1${
		versionId ? `&version=${encodeURIComponent(versionId)}` : ""
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
		queryFn: () =>
			bff.get<PopcornProject>("/popcorn", { project_id: projectId }),
		// No polling: the session page's event stream invalidates this query.
		queryKey: projectKey(projectId),
	});

// Every mutation that returns the session writes it back into the project
// query, readiness and all.
const putPopcorn = (
	queryClient: ReturnType<typeof useQueryClient>,
	projectId: string,
	detail: PopcornDetail,
) =>
	queryClient.setQueryData(
		projectKey(projectId),
		(old: PopcornProject | undefined): PopcornProject => ({
			...(old ?? {}),
			popcorn: detail,
		}),
	);

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
		// Invalidated by the session page's event stream when a read finishes.
		queryKey: ["popcorn", popcornId, "versions"],
	});

export const useCreatePopcornMutation = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			title: string;
			client?: string;
			voice?: Partial<PopcornVoice>;
		}) =>
			bff.post<PopcornDetail>("/popcorn", {
				project_id: projectId,
				...payload,
			}),
		onError: () => toast.error(t`Could not run popcorn`),
		onSuccess: (detail) => putPopcorn(queryClient, projectId, detail),
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
		onSuccess: (detail) => putPopcorn(queryClient, projectId, detail),
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

export const useRerunPopcornMutation = (
	projectId: string,
	popcornId: string,
) => {
	const invalidate = useInvalidatePopcorn(projectId);
	return useMutation({
		mutationFn: () =>
			bff.post<{ tick: string }>(
				`/popcorn/${encodeURIComponent(popcornId)}/rerun`,
			),
		onError: (error: Error & { status?: number }) => {
			if (error.status === 429) {
				toast.info(t`Just read. Give it a moment.`);
				return;
			}
			toast.error(t`Could not rerun popcorn`);
		},
		onSuccess: () => {
			toast.success(t`Reading everything again`);
			invalidate();
		},
	});
};

export const usePopcornLiveMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (hours: LiveHours) =>
			bff.post<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/live`,
				{ hours },
			),
		onError: () => toast.error(t`Could not go live`),
		onSuccess: (detail) => putPopcorn(queryClient, projectId, detail),
	});
};

export const usePopcornStopLiveMutation = (
	projectId: string,
	popcornId: string,
) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			bff.post<PopcornDetail>(
				`/popcorn/${encodeURIComponent(popcornId)}/live/stop`,
			),
		onError: () => toast.error(t`Could not stop live`),
		onSuccess: (detail) => putPopcorn(queryClient, projectId, detail),
	});
};
