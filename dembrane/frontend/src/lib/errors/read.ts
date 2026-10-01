import type { ErrorCode, FieldErrorCode } from "./catalog/index.gen";
import type { ErrorAction } from "./catalog/types.gen";

/** A failing form field as the API lists it in a validation error's params.fields. */
export interface FieldProblem {
	/** Dotted path without the "body" or "query" root: "name", "items.0.title". */
	readonly field: string;
	readonly code: FieldErrorCode | string;
	readonly params: Readonly<Record<string, unknown>>;
}

/**
 * What the screen needs from a failed request, whichever client made it (axios, the bff
 * wrapper, a plain fetch). `code` is null when the response carried none (an old API, a
 * proxy error page, no response at all); `network` is true when nothing came back.
 */
export interface ApiError {
	readonly status: number | null;
	readonly code: ErrorCode | string | null;
	readonly params: Readonly<Record<string, unknown>>;
	readonly action: ErrorAction | null;
	readonly fields: readonly FieldProblem[];
	readonly network: boolean;
}

const ACTIONS = new Set<string>([
	"retry",
	"sign_in",
	"contact_admin",
	"contact_support",
	"upgrade",
	"fix_input",
	"wait",
	"none",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);

/**
 * A failed response thrown by fetch-based callers (bff, billing, uploads), carrying the
 * parsed body so the presenter reads its code. `message` stays the backend detail for
 * logs; screens show the presenter's message, never this one.
 */
export class ApiRequestError extends Error {
	readonly status: number;
	readonly body: unknown;
	/** The FastAPI detail, kept for the few callers that read structured details (409s). */
	readonly detail: unknown;
	constructor(status: number, body: unknown) {
		const detail = isRecord(body) ? body.detail : undefined;
		super(typeof detail === "string" ? detail : `HTTP ${status}`);
		this.name = "ApiRequestError";
		this.status = status;
		this.body = body;
		this.detail = detail;
	}
}

/** Throws an ApiRequestError for a non-2xx fetch response; returns it untouched otherwise. */
export async function ensureOk(res: Response): Promise<Response> {
	if (res.ok) return res;
	const body = await res.json().catch(() => null);
	throw new ApiRequestError(res.status, body);
}

function bodyOf(err: unknown): { status: number | null; body: unknown } {
	if (err instanceof ApiRequestError)
		return { body: err.body, status: err.status };
	if (!isRecord(err)) return { body: null, status: null };
	const response = err.response;
	if (isRecord(response))
		return {
			body: response.data,
			status: typeof response.status === "number" ? response.status : null,
		};
	// A plain body passed straight in, or an error a caller built with status and body.
	if ("code" in err && "action" in err) return { body: err, status: null };
	const status = typeof err.status === "number" ? err.status : null;
	if ("body" in err) return { body: err.body, status };
	if ("detail" in err) return { body: { detail: err.detail }, status };
	return { body: null, status };
}

function isNetworkFailure(err: unknown, status: number | null): boolean {
	if (status !== null) return false;
	if (!isRecord(err) && !(err instanceof Error)) return false;
	const e = err as { code?: unknown; message?: unknown; request?: unknown };
	if (e.code === "ERR_NETWORK" || e.code === "ECONNABORTED") return true;
	const message = typeof e.message === "string" ? e.message : "";
	return (
		message === "Failed to fetch" ||
		message.includes("fetch failed") ||
		message === "Network Error" ||
		message.includes("NetworkError")
	);
}

function fieldsOf(params: Record<string, unknown>): FieldProblem[] {
	const list = params.fields;
	if (!Array.isArray(list)) return [];
	return list.filter(isRecord).map((f) => ({
		code: typeof f.code === "string" ? f.code : "field.invalid",
		field: typeof f.field === "string" ? f.field : "",
		params: isRecord(f.params) ? f.params : {},
	}));
}

/** Reads any thrown value into the parts the presenter needs. Never throws. */
export function readApiError(err: unknown): ApiError {
	const { body, status } = bodyOf(err);
	const data = isRecord(body) ? body : {};
	const code = typeof data.code === "string" ? data.code : null;
	const params = isRecord(data.params) ? data.params : {};
	const action =
		typeof data.action === "string" && ACTIONS.has(data.action)
			? (data.action as ErrorAction)
			: null;
	return {
		action,
		code,
		fields: fieldsOf(params),
		network: isNetworkFailure(err, status),
		params,
		status,
	};
}

/** The error's code, when it has one. */
export function errorCode(err: unknown): string | null {
	return readApiError(err).code;
}
