import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifyError } from "@/components/error";
import { api } from "@/lib/api";

// Apps whose material reaches a project as inputs (platform package `connectors`).

export type ConnectorVoice = "participants" | "organisers" | "mixed";

export interface ConnectorProvider {
	provider: "miro";
	label: string;
	configured: boolean;
	connected: boolean;
	account_name: string | null;
}

export interface MiroBoard {
	id: string;
	name: string;
	url: string | null;
}

export interface MiroFrame {
	id: string;
	title: string;
}

export interface ConnectorSource {
	id: string;
	provider: "miro";
	external_id: string;
	name: string | null;
	url: string | null;
	frame_ids: string[];
	voice: ConnectorVoice;
	status: "pending" | "syncing" | "ok" | "error";
	error: "not_connected" | "board_not_found" | "provider_refused" | null;
	connected: boolean;
	inputs: number;
	last_synced_at: string | null;
	created_at: string;
}

const keys = {
	boards: (projectId: string, query: string) =>
		["projects", projectId, "connectors", "miro", "boards", query] as const,
	frames: (projectId: string, boardId: string) =>
		["projects", projectId, "connectors", "miro", "frames", boardId] as const,
	providers: ["connectors"] as const,
	sources: (projectId: string) =>
		["projects", projectId, "connector-sources"] as const,
};

export const useConnectorProviders = () =>
	useQuery({
		queryFn: () => api.get<unknown, ConnectorProvider[]>("/connectors"),
		queryKey: keys.providers,
	});

export const useConnectorSources = (projectId: string, enabled: boolean) =>
	useQuery({
		enabled,
		queryFn: () =>
			api.get<unknown, ConnectorSource[]>(
				`/projects/${projectId}/connector-sources`,
			),
		queryKey: keys.sources(projectId),
		// A sync runs in the background; follow it until it settles.
		refetchInterval: (q) =>
			q.state.data?.some(
				(s) => s.status === "pending" || s.status === "syncing",
			)
				? 4000
				: false,
	});

export const useMiroBoards = (
	projectId: string,
	query: string,
	enabled: boolean,
) =>
	useQuery({
		enabled,
		queryFn: () =>
			api.get<unknown, MiroBoard[]>(
				`/projects/${projectId}/connectors/miro/boards`,
				{ params: query ? { query } : {} },
			),
		queryKey: keys.boards(projectId, query),
	});

export const useMiroFrames = (projectId: string, boardId: string | null) =>
	useQuery({
		enabled: !!boardId,
		queryFn: () =>
			api.get<unknown, MiroFrame[]>(
				`/projects/${projectId}/connectors/miro/boards/${encodeURIComponent(boardId ?? "")}/frames`,
			),
		queryKey: keys.frames(projectId, boardId ?? ""),
	});

/** Sends the browser to Miro's sign-in; it comes back to the integrations page. */
export const useConnectMiro = (projectId: string) =>
	useMutation({
		mutationFn: () =>
			api.get<unknown, { url: string }>(
				`/projects/${projectId}/connectors/miro/authorize`,
			),
		onError: (error) => void notifyError(error),
		onSuccess: ({ url }) => {
			window.location.assign(url);
		},
	});

export const useDisconnectMiro = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.delete("/connectors/miro"),
		onError: (error) => void notifyError(error),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.providers });
			qc.invalidateQueries({ queryKey: ["projects"] });
		},
	});
};

export const useSaveSource = (projectId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (
			body:
				| {
						id?: undefined;
						board: string;
						frame_ids: string[];
						voice: ConnectorVoice;
				  }
				| { id: string; frame_ids: string[]; voice: ConnectorVoice },
		) =>
			body.id
				? api.patch<unknown, ConnectorSource>(
						`/projects/${projectId}/connector-sources/${body.id}`,
						{ frame_ids: body.frame_ids, voice: body.voice },
					)
				: api.post<unknown, ConnectorSource>(
						`/projects/${projectId}/connector-sources`,
						{ ...body, provider: "miro" },
					),
		onError: (error) => void notifyError(error),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: keys.sources(projectId) }),
	});
};

export const useSyncSource = (projectId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			api.post(`/projects/${projectId}/connector-sources/${id}/sync`),
		onError: (error) => void notifyError(error),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: keys.sources(projectId) }),
	});
};

export const useRemoveSource = (projectId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			api.delete(`/projects/${projectId}/connector-sources/${id}`),
		onError: (error) => void notifyError(error),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.sources(projectId) });
			// Its inputs went with it.
			qc.invalidateQueries({ queryKey: ["projects", projectId] });
		},
	});
};
