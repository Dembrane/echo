import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * The context digest (ECHO-1055): a host drops an agenda, invitation, slides or a brief
 * and dembrane proposes the project setup. The browser extracts the text (./extract); the
 * server (platform/packages/projects/src/setup/digest.ts) condenses it, asks the model and
 * holds every rule. These screens show, edit and switch off; nothing is saved until the
 * host presses Create.
 */

export type SourceKind = "file" | "text" | "url";

/** What is sent for one source: never a file, only its text, name and kind. */
export interface DigestSourceBody {
	name: string;
	kind: SourceKind;
	text?: string;
	url?: string;
}

export interface DigestRequestBody {
	sources: DigestSourceBody[];
	language: string;
	existing?: { name?: string; context?: string; key_terms?: string[] } | null;
}

export interface DigestProvenance {
	source: string;
	snippet: string;
}

export interface DigestTerm {
	term: string;
	reason: string;
	source: string;
	snippet: string;
}

export type DigestNote =
	| "url_not_read"
	| "material_cut"
	| "nothing_found"
	| "personal_data_removed"
	| "at_cap";

export type ProvenanceField =
	| "name"
	| "goal"
	| "context"
	| "template_key"
	| "tags"
	| "name_label"
	| "verify_topics"
	| "explore_prompt"
	| "host_script_additions";

export interface DigestResult {
	name?: string;
	goal?: string;
	context?: string;
	key_terms: DigestTerm[];
	template?: { key: string; reason: string; runner_ups: string[] };
	tags?: string[];
	name_label?: string;
	verify_topics?: string[];
	explore_prompt?: string;
	host_script_additions?: string[];
	provenance: Partial<Record<ProvenanceField, DigestProvenance>>;
	notes: DigestNote[];
	sources: {
		name: string;
		kind: SourceKind;
		chars: number;
		condensed: boolean;
	}[];
	max_key_terms: number;
}

export async function requestDigest(
	workspaceId: string,
	body: DigestRequestBody,
	signal?: AbortSignal,
): Promise<DigestResult> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/project-setup/digest`,
		{
			body: JSON.stringify(body),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
			signal,
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

/** The parts of a result with content: none means the digest found nothing to use. */
export function fieldsReturned(r: DigestResult): string[] {
	const f: string[] = [];
	if (r.name) f.push("name");
	if (r.goal) f.push("goal");
	if (r.context) f.push("context");
	if (r.key_terms.length) f.push("key_terms");
	if (r.template) f.push("template");
	if (r.tags?.length) f.push("tags");
	if (r.name_label) f.push("name_label");
	if (r.verify_topics?.length) f.push("verify_topics");
	if (r.explore_prompt) f.push("explore_prompt");
	if (r.host_script_additions?.length) f.push("host_script_additions");
	return f;
}

/** A result worth reviewing: a template or a name, and something more. */
export const isUseful = (r: DigestResult) =>
	!r.notes.includes("nothing_found") && fieldsReturned(r).length >= 2;

// ── Analytics: counts and buckets only, never names, text, terms or snippets ──

export const charsBucket = (n: number) =>
	n < 1_000 ? "<1k" : n < 10_000 ? "1k-10k" : n < 50_000 ? "10k-50k" : "50k+";

export const durationBucket = (ms: number) =>
	ms < 5_000 ? "<5s" : ms < 15_000 ? "5-15s" : ms < 30_000 ? "15-30s" : "30s+";

export type DigestFailure =
	| "budget"
	| "rate_limited"
	| "unavailable"
	| "invalid"
	| "forbidden"
	| "network"
	| "nothing_found"
	| "no_readable_files"
	| "error";

export function failureCause(error: unknown): DigestFailure {
	if (!(error instanceof ApiRequestError))
		return error instanceof TypeError ? "network" : "error";
	if (error.status === 402) return "budget";
	if (error.status === 429) return "rate_limited";
	if (error.status === 503) return "unavailable";
	if (error.status === 400 || error.status === 422) return "invalid";
	if (error.status === 403 || error.status === 404) return "forbidden";
	return "error";
}
