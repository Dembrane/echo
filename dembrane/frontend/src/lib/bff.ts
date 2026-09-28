import { i18n } from "@lingui/core";
import { API_BASE_URL } from "@/config";
import { loadErrorMessages } from "@/lib/errors/present";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * Thin fetch wrapper for /v2/bff/* endpoints.
 *
 * Keeps credentials + error handling consistent across hooks so each
 * migrated call site can shrink to a single `bff.get("/conversations",
 * { project_id })` instead of boilerplating URLSearchParams + credentials
 * + error-json parsing. All bff endpoints return JSON on success and
 * `{detail: string}` on failure.
 */

type Params = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, params?: Params): string {
	const url = new URL(
		`${API_BASE_URL}/v2/bff${path}`,
		typeof window !== "undefined" ? window.location.origin : "http://localhost",
	);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === null || v === undefined) continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url.toString();
}

/**
 * A failed bff call as an ApiRequestError: `message` keeps the backend detail for logs,
 * `detail` the structured body (a 409 answers with the conflicting revision), and the
 * error presenter reads the code from `body`.
 */
async function parseError(res: Response): Promise<ApiRequestError> {
	const data = await res.json().catch(() => ({}));
	const error = new ApiRequestError(res.status, data);
	void loadErrorMessages(i18n);
	return error;
}

export const bff = {
	async delete<T = unknown>(path: string): Promise<T> {
		const res = await fetch(buildUrl(path), {
			credentials: "include",
			method: "DELETE",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async get<T = unknown>(path: string, params?: Params): Promise<T> {
		const res = await fetch(buildUrl(path, params), {
			credentials: "include",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(buildUrl(path), {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			method: "PATCH",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async post<T = unknown>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(buildUrl(path), {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			method: "POST",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async put<T = unknown>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(buildUrl(path), {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			method: "PUT",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
};
