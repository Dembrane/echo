import { API_BASE_URL } from "@/config";

/**
 * Thin fetch wrapper for /v2/bff/* endpoints.
 *
 * Keeps credentials + error handling consistent across hooks so each
 * migrated call site can shrink to a single `bff.get("/conversations",
 * { project_id })` instead of boilerplating URLSearchParams + credentials
 * + error-json parsing. All bff endpoints return JSON on success and
 * `{detail: string}` on failure.
 */

type Params = Record<
	string,
	string | number | boolean | null | undefined
>;

function buildUrl(path: string, params?: Params): string {
	const url = new URL(
		`${API_BASE_URL}/v2/bff${path}`,
		typeof window !== "undefined"
			? window.location.origin
			: "http://localhost",
	);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === null || v === undefined) continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url.toString();
}

async function parseError(res: Response): Promise<Error> {
	const data = await res.json().catch(() => ({}));
	const detail =
		typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`;
	return new Error(detail);
}

export const bff = {
	async get<T = unknown>(path: string, params?: Params): Promise<T> {
		const res = await fetch(buildUrl(path, params), {
			credentials: "include",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async post<T = unknown>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(buildUrl(path), {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			method: "POST",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
		const res = await fetch(buildUrl(path), {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			method: "PATCH",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
	async delete<T = unknown>(path: string): Promise<T> {
		const res = await fetch(buildUrl(path), {
			credentials: "include",
			method: "DELETE",
		});
		if (!res.ok) throw await parseError(res);
		return (await res.json()) as T;
	},
};
