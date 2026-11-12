import { API_BASE_URL } from "@/config";
import { ApiRequestError, ensureOk } from "@/lib/errors/read";

/**
 * A JSON call to the API outside the bff (`${API_BASE_URL}${path}`), with the session
 * cookie. A non-2xx answer throws an ApiRequestError (ensureOk), which the error presenter
 * reads; callers map it to their own screens and analytics.
 */
export async function apiJson<T>(
	path: string,
	init: {
		method?: "GET" | "POST" | "PATCH";
		body?: unknown;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	const res = await fetch(`${API_BASE_URL}${path}`, {
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		credentials: "include",
		headers:
			init.body === undefined
				? undefined
				: { "Content-Type": "application/json" },
		method: init.method ?? "GET",
		signal: init.signal,
	});
	await ensureOk(res);
	return (await res.json()) as T;
}

/** POST `body` as JSON; see apiJson. */
export const postJson = <T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
) => apiJson<T>(path, { body, method: "POST", signal });

/** Why an AI request failed, as analytics records it. Never the text, the URL or the terms. */
export type RequestFailure =
	| "budget"
	| "unavailable"
	| "rate_limited"
	| "invalid"
	| "forbidden"
	| "network"
	| "error";

/** The analytics cause of a failed apiJson call (setup suggestions, the digest, Try it). */
export function requestFailure(error: unknown): RequestFailure {
	if (!(error instanceof ApiRequestError))
		return error instanceof TypeError ? "network" : "error";
	if (error.status === 402) return "budget";
	if (error.status === 503) return "unavailable";
	if (error.status === 429) return "rate_limited";
	if (error.status === 400 || error.status === 422) return "invalid";
	if (error.status === 403 || error.status === 404) return "forbidden";
	return "error";
}
