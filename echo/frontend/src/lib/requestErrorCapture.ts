import posthog from "posthog-js";

/**
 * Central capture point for failed React Query requests.
 *
 * A queryFn that captures inside its own try/catch fires once per attempt, so
 * a query with `retry: 2` reports the same failure up to three times. Worse,
 * a transient connectivity blip (fetch rejects with a `TypeError`) then lands
 * in error tracking at error level, where it is pure noise. Route capture
 * through the React Query cache error handlers instead: those fire once, after
 * the retries are spent, so each failure is recorded a single time.
 */

// fetch() rejects with a TypeError when the request never reaches an HTTP
// response — offline, DNS failure, dropped connection, blocked by CORS. Some
// environments word it differently, so match the common messages too.
const NETWORK_ERROR_HINTS = [
	"failed to fetch",
	"networkerror",
	"network request failed",
	"load failed",
];

export const isNetworkError = (error: unknown): boolean => {
	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		return true;
	}
	if (error instanceof TypeError) {
		return true;
	}
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return NETWORK_ERROR_HINTS.some((hint) => message.includes(hint));
};

/**
 * Record a failed request once its retries are exhausted. A bare connectivity
 * blip is not an application error, so it lands as a low-severity event and
 * stays out of error tracking; anything else is captured as an exception. Both
 * carry the request name and whether the browser was offline.
 */
export const captureRequestError = (
	error: unknown,
	requestName: string,
): void => {
	const offline = typeof navigator !== "undefined" && !navigator.onLine;

	if (isNetworkError(error)) {
		posthog.capture("request_network_error", {
			offline,
			request: requestName,
		});
		return;
	}

	posthog.captureException(error, {
		offline,
		request: requestName,
	});
};

/**
 * React Query cache error handler helper. Only requests that opt in with a
 * `meta.errorName` are captured, so this never widens capture to every query
 * in the app.
 */
export const captureRequestErrorFromMeta = (
	error: unknown,
	meta: Record<string, unknown> | undefined,
): void => {
	const requestName = meta?.errorName;
	if (typeof requestName === "string") {
		captureRequestError(error, requestName);
	}
};
