import { useMutation } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * Setup suggestions (ECHO-1043): what dembrane proposes from what a host says about a
 * session. The server (platform/packages/projects/src/setup) holds every rule: at most 30
 * key terms in all, each one found literally in what the host gave, settings only on top
 * of the chosen template. The screens only show, accept and remove.
 */

/** Most key terms a project holds after accepting, the host's own ones included. */
export const MAX_KEY_TERMS = 30;
/** The most of the project context a suggestion request reads; the saved context is not cut. */
export const MAX_SOURCE_CHARS = 20_000;
/** From here on the block says "x of 30". */
export const NEAR_CAP = 24;

export type TermSource = "description" | "text" | "url";

export interface ProposedTerm {
	term: string;
	reason: string;
	source: TermSource;
}

export interface ProposedSetting {
	field: string;
	/** The value once the template is applied. */
	current: boolean | string;
	proposed: boolean | string;
	reason: string;
}

export type SuggestionNote = "url_not_read" | "at_cap";

export interface SetupSuggestions {
	key_terms: ProposedTerm[];
	settings: ProposedSetting[];
	notes: SuggestionNote[];
	max_key_terms: number;
}

export interface SuggestionRequest {
	template_key: string;
	name: string;
	description?: string | null;
	source_text?: string | null;
	source_url?: string | null;
	language: string;
	existing_key_terms: string[];
	include_settings?: boolean;
}

/** Where the block sits, for analytics. */
export type SuggestionSurface = "wizard" | "portal_editor";

/** Why a request failed, as analytics records it. Never the text, the URL or the terms. */
export type FailureCause =
	| "budget"
	| "unavailable"
	| "rate_limited"
	| "invalid"
	| "forbidden"
	| "network"
	| "error";

export function failureCause(error: unknown): FailureCause {
	if (!(error instanceof ApiRequestError))
		return error instanceof TypeError ? "network" : "error";
	if (error.status === 402) return "budget";
	if (error.status === 503) return "unavailable";
	if (error.status === 429) return "rate_limited";
	if (error.status === 422) return "invalid";
	if (error.status === 403 || error.status === 404) return "forbidden";
	return "error";
}

export async function requestSetupSuggestions(
	workspaceId: string,
	body: SuggestionRequest,
): Promise<SetupSuggestions> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/project-setup/suggestions`,
		{
			body: JSON.stringify(body),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

/** The request, without the global error toast: the block shows its own quiet line. */
export const useSetupSuggestionsMutation = (workspaceId: string | null) =>
	useMutation({
		mutationFn: (body: SuggestionRequest) => {
			if (!workspaceId) throw new Error("No workspace selected");
			return requestSetupSuggestions(workspaceId, body);
		},
	});

/** Key terms as the stored comma-separated value lists them, each once. */
export const splitTerms = (value: string): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of value.split(",")) {
		const term = raw.trim();
		const key = term.toLocaleLowerCase();
		if (!term || seen.has(key)) continue;
		seen.add(key);
		out.push(term);
	}
	return out;
};

export const hasTerm = (value: string, term: string) =>
	splitTerms(value).some(
		(t) => t.toLocaleLowerCase() === term.toLocaleLowerCase(),
	);

export const addTerms = (value: string, terms: string[]) => {
	const list = splitTerms(value);
	for (const term of terms)
		if (
			list.length < MAX_KEY_TERMS &&
			!list.some((t) => t.toLocaleLowerCase() === term.toLocaleLowerCase())
		)
			list.push(term);
	return list.join(", ");
};

export const removeTerm = (value: string, term: string) =>
	splitTerms(value)
		.filter((t) => t.toLocaleLowerCase() !== term.toLocaleLowerCase())
		.join(", ");
