import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

// AI provider: which an account allows (read here, set by dembrane staff) and which one
// each project uses. Session-authenticated against /v2/orgs and /v2/projects.

export type AiProvider = "scaleway" | "google";

/** The two choices of an account: who hears the audio, and who reads the text. */
export type AiJob = "transcription" | "analysis";
export const AI_JOBS: readonly AiJob[] = ["transcription", "analysis"];

/** What one provider costs for one job, as the server worked it out from the call log. */
/** The model ids each provider uses for each job, from the deployment's config. */
export type AiModels = Partial<Record<AiProvider, Partial<Record<AiJob, string[]>>>>;

export interface CostLine {
	job: AiJob;
	provider: AiProvider;
	billing: "included" | "on_top";
	/** Euros a month at the last 30 days of use; null with no use of this job yet. */
	monthly_eur: number | null;
	/** With no use: euros for an hour of audio. */
	per_hour_eur: number | null;
	/** With no use: euros for 100 analysis calls. */
	per_100_calls_eur: number | null;
}

export type CostLines = Record<AiJob, Partial<Record<AiProvider, CostLine>>>;

export interface AiHistoryLine {
	at: string;
	kind: "enabled" | "disabled" | "default";
	provider: AiProvider;
	job: AiJob;
	request_at: string | null;
	/** Staff only: who made the change. */
	by?: string | null;
}

export interface OrgAiProviders {
	jobs: AiJob[];
	available: AiProvider[];
	/** The jobs each provider serves. */
	serves: Record<AiProvider, AiJob[]>;
	environment_default: AiProvider;
	/** What the account has enabled for each job. */
	enabled: Record<AiJob, AiProvider[]>;
	defaults: Record<AiJob, AiProvider>;
	/** The model ids each provider uses for each job on this deployment, from its config. */
	models?: AiModels;
	cost: CostLines;
	/** What the account has spent since the month began, in euros. */
	month: { from: string; spent: Record<AiProvider, number> };
	history: AiHistoryLine[];
}

export interface JobChoice {
	options: AiProvider[];
	account_default: AiProvider;
	current: AiProvider | null;
	effective: AiProvider;
}

export interface ProjectAiProviders {
	jobs: Record<AiJob, JobChoice>;
	can_change: boolean;
	/** The model ids each provider uses for each job on this deployment, from its config. */
	models?: AiModels;
	/** What each provider would cost this project from its own last 30 days. */
	cost: CostLines;
}

class AiProviderError extends ApiRequestError {}

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
		throw new AiProviderError(response.status, data);
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
		mutationFn: ({
			job,
			provider,
		}: {
			job: AiJob;
			provider: AiProvider | null;
		}) =>
			aiRequest<ProjectAiProviders>(`/v2/projects/${projectId}/ai-provider`, {
				body: JSON.stringify({ job, provider }),
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

/** Its name alone, for a history line. */
export const providerName = (p: AiProvider): string =>
	p === "google" ? t`Google Vertex AI` : t`Scaleway`;

export const jobName = (job: AiJob): string =>
	job === "transcription" ? t`Transcription` : t`Analysis`;

/**
 * Euros as the reader's locale writes them ("€12" in English, "€ 12" in Dutch). An estimate is
 * a whole amount from one euro up, a price or an amount spent is exact to the cent.
 */
export const euros = (
	n: number,
	locale: string,
	style: "estimate" | "exact" = "exact",
): string => {
	const whole = style === "estimate" && n >= 1;
	return new Intl.NumberFormat(locale, {
		currency: "EUR",
		maximumFractionDigits: whole ? 0 : 2,
		minimumFractionDigits: whole ? 0 : 2,
		style: "currency",
	}).format(n);
};

/**
 * The one cost line of a provider card: included in the plan, or about what the account's own
 * last 30 days would cost, or with no use yet the price of an hour of audio or 100 questions.
 * Null when there is nothing honest to say.
 */
export const costText = (
	line: CostLine | undefined,
	locale: string,
): string | null => {
	if (!line) return null;
	if (line.billing === "included") return t`Included in your plan`;
	if (line.monthly_eur !== null) {
		const n = euros(line.monthly_eur, locale, "estimate");
		return t`About ${n} a month at your last 30 days of use, billed on top`;
	}
	if (line.per_hour_eur !== null) {
		const n = euros(line.per_hour_eur, locale);
		return t`${n} per hour of audio`;
	}
	if (line.per_100_calls_eur !== null) {
		const n = euros(line.per_100_calls_eur, locale);
		return t`${n} per 100 questions`;
	}
	return null;
};

// "3 Dec 2026": English reads day first here, as dembrane writes dates to customers.
export const formatDay = (iso: string, locale: string): string =>
	new Intl.DateTimeFormat(locale.startsWith("en") ? "en-GB" : locale, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(new Date(iso));
