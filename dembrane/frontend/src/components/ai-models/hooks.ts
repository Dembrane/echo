import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

// AI providers: which an account allows (read here, set by dembrane staff) and which one
// each project uses. Session-authenticated against /v2/orgs and /v2/projects.

export type AiProvider = "scaleway" | "google";

export interface AiHistoryLine {
	at: string;
	kind: "added" | "removed" | "default";
	provider: AiProvider;
	request_at: string | null;
	/** Staff only: who made the change. */
	by?: string | null;
}

export interface OrgAiProviders {
	available: AiProvider[];
	environment_default: AiProvider;
	allowed: AiProvider[];
	default: AiProvider;
	history: AiHistoryLine[];
}

export interface ProjectAiProviders {
	options: AiProvider[];
	account_default: AiProvider;
	current: AiProvider | null;
	effective: AiProvider;
	can_change: boolean;
}

class AiModelsError extends ApiRequestError {}

export const aiRequest = async <T>(
	path: string,
	init: RequestInit = {},
): Promise<T> => {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		credentials: "include",
		...init,
		headers: {
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new AiModelsError(response.status, data);
	}
	return response.json();
};

export const aiKeys = {
	org: (orgId: string) => ["v2", "ai-providers", "org", orgId] as const,
	project: (projectId: string) =>
		["v2", "ai-providers", "project", projectId] as const,
};

export const useOrgAiProvidersQuery = (orgId: string | undefined) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () => aiRequest<OrgAiProviders>(`/v2/orgs/${orgId}/ai-providers`),
		queryKey: aiKeys.org(orgId ?? ""),
		staleTime: 30_000,
	});

export const useProjectAiProviderQuery = (projectId: string | undefined) =>
	useQuery({
		enabled: Boolean(projectId),
		queryFn: () =>
			aiRequest<ProjectAiProviders>(`/v2/projects/${projectId}/ai-provider`),
		queryKey: aiKeys.project(projectId ?? ""),
		staleTime: 30_000,
	});

export const useSetProjectAiProviderMutation = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (provider: AiProvider | null) =>
			aiRequest<ProjectAiProviders>(`/v2/projects/${projectId}/ai-provider`, {
				body: JSON.stringify({ provider }),
				method: "PUT",
			}),
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: (data) => {
			queryClient.setQueryData(aiKeys.project(projectId), data);
		},
	});
};

/** The provider as a person reads it: its name and where it runs. */
export const providerLabel = (p: AiProvider): string =>
	p === "google" ? t`Google Vertex AI, EU` : t`Scaleway, Paris`;

/** Its name alone, for a history line. */
export const providerName = (p: AiProvider): string =>
	p === "google" ? t`Google Vertex AI` : t`Scaleway`;

// "3 Dec 2026": English reads day first here, as dembrane writes dates to customers.
export const formatDay = (iso: string, locale: string): string =>
	new Intl.DateTimeFormat(locale.startsWith("en") ? "en-GB" : locale, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(new Date(iso));
