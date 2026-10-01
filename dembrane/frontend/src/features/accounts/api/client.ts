import { i18n } from "@lingui/core";
import type { z } from "zod4";
import { API_BASE_URL } from "@/config";
import { presentError } from "@/lib/errors/present";
import { ErrorBody, ROUTES, type RouteName } from "../contract/contract.gen";

/**
 * The accounts API as the screens see it: one call per contract route, the request
 * validated and the response parsed by the route's own schema in contract.gen.ts.
 *
 * Fixture mode (VITE_ACCOUNTS_FIXTURES=1 at build or dev time) answers the same calls from
 * an in-memory copy of the Example Town Council (sample) demo, parsed by the same schemas, so
 * the screens run before the backend handlers land and switch to the real API with no
 * change. The check is a build-time constant, so a normal build drops the fixture code.
 */
export const FIXTURE_MODE = import.meta.env.VITE_ACCOUNTS_FIXTURES === "1";

type Routes = typeof ROUTES;
type Spec<N extends RouteName> = Routes[N];

export type ResponseOf<N extends RouteName> = Spec<N> extends {
	response: infer R extends z.ZodType;
}
	? z.output<R>
	: never;
export type RequestOf<N extends RouteName> = Spec<N> extends {
	request: infer R extends z.ZodType;
}
	? z.input<R>
	: undefined;

export type Params = Record<string, string>;

export interface CallOptions<N extends RouteName> {
	params?: Params;
	body?: RequestOf<N>;
	query?: Record<string, string | number | undefined>;
}

export class AccountsApiError extends Error {
	readonly status: number;
	/** Field-level problems from a 422, keyed by the field name. */
	fields: Record<string, string>;
	/** The response body; the error presenter (lib/errors) reads its code. */
	readonly body: unknown;
	constructor(
		status: number,
		message: string,
		fields: Record<string, string> = {},
		body: unknown = null,
	) {
		super(message);
		this.status = status;
		this.fields = fields;
		this.body = body;
	}
}

export const fillPath = (path: string, params: Params = {}): string =>
	path.replace(/:(\w+)/g, (_, key: string) => {
		const value = params[key];
		if (!value) throw new Error(`Missing route param ${key}`);
		return encodeURIComponent(value);
	});

/** Contract paths start with /api; API_BASE_URL already ends in it. */
export const apiUrl = (contractPath: string): string =>
	`${API_BASE_URL}${contractPath.replace(/^\/api(?=\/)/, "")}`;

type FixtureModule = typeof import("./fixtureBackend");
let fixtures: Promise<FixtureModule> | null = null;
export const loadFixtures = (): Promise<FixtureModule> => {
	fixtures ??= import("./fixtureBackend");
	return fixtures;
};

const toApiError = async (
	status: number,
	raw: unknown,
): Promise<AccountsApiError> => {
	const parsed = ErrorBody.safeParse(raw);
	if (!parsed.success)
		return new AccountsApiError(status, `HTTP ${status}`, {}, raw);
	const { detail } = parsed.data;
	if (typeof detail === "string")
		return new AccountsApiError(status, detail, {}, raw);
	const fields: Record<string, string> = {};
	for (const issue of detail) {
		const key = issue.loc.filter((l) => l !== "body").join(".");
		fields[key] ??= issue.msg;
	}
	const error = new AccountsApiError(
		status,
		detail[0]?.msg ?? `HTTP ${status}`,
		fields,
		raw,
	);
	// Field messages by field code in the person's language, where the API sent codes.
	const presented = await presentError(error, i18n);
	if (Object.keys(presented.fields).length)
		error.fields = { ...presented.fields };
	return error;
};

/**
 * The field code for a zod issue, the same mapping the platform's accounts validator uses
 * (platform/packages/accounts/src/validate.ts), so a check that fails here reads exactly
 * like the 422 the API would send.
 */
function zodFieldCode(i: z.core.$ZodIssue): string {
	switch (i.code) {
		case "invalid_type":
			return i.input === undefined ? "field.required" : "field.invalid_type";
		case "too_small":
			if (i.origin === "string") return "field.too_short";
			if (i.origin === "array" || i.origin === "set")
				return "field.too_few_items";
			return "field.too_small";
		case "too_big":
			return i.origin === "string" ? "field.too_long" : "field.too_large";
		case "invalid_format":
			if (i.format === "email") return "field.invalid_email";
			if (i.format === "url") return "field.invalid_url";
			if (i.format === "date" || i.format === "datetime")
				return "field.invalid_date";
			return "field.invalid";
		case "invalid_value":
			return "field.invalid_choice";
		default:
			return "field.invalid";
	}
}

function zodFieldParams(i: z.core.$ZodIssue): Record<string, string | number> {
	if (i.code === "too_small") {
		const min = Number(i.minimum);
		return i.origin === "string" || i.origin === "array" || i.origin === "set"
			? { min_length: min }
			: { min };
	}
	if (i.code === "too_big") {
		const max = Number(i.maximum);
		return i.origin === "string" ? { max_length: max } : { max };
	}
	return {};
}

/**
 * Turns a zod failure on our own request into the same error a 422 would give: field
 * codes, worded by the error presenter in the person's language (never zod's English).
 */
const requestError = async (error: z.ZodError): Promise<AccountsApiError> => {
	const body = {
		action: "fix_input",
		code: "validation.invalid_input",
		detail: "Request validation failed",
		params: {
			fields: error.issues.map((i) => ({
				code: zodFieldCode(i),
				field: i.path.map(String).join("."),
				params: zodFieldParams(i),
			})),
		},
	};
	const result = new AccountsApiError(
		422,
		"Request validation failed",
		{},
		body,
	);
	const presented = await presentError(result, i18n);
	result.fields = { ...presented.fields };
	return result;
};

export async function call<N extends RouteName>(
	name: N,
	options: CallOptions<N> = {},
): Promise<ResponseOf<N>> {
	const spec = ROUTES[name] as {
		method: string;
		path: string;
		request?: z.ZodType;
		response?: z.ZodType;
	};
	const path = fillPath(spec.path, options.params);

	let body: unknown;
	if (spec.request) {
		const parsed = spec.request.safeParse(options.body ?? {});
		if (!parsed.success) throw await requestError(parsed.error);
		body = parsed.data;
	}

	let json: unknown;
	if (FIXTURE_MODE) {
		const fx = await loadFixtures();
		json = await fx.handle(name, options.params ?? {}, body, options.query);
	} else {
		const qs = options.query
			? `?${new URLSearchParams(
					Object.entries(options.query)
						.filter(([, v]) => v !== undefined)
						.map(([k, v]) => [k, String(v)]),
				).toString()}`
			: "";
		const res = await fetch(`${apiUrl(path)}${qs}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "include",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			method: spec.method,
		});
		const raw = await res.json().catch(() => null);
		if (!res.ok) throw await toApiError(res.status, raw);
		json = raw;
	}
	if (!spec.response) return json as ResponseOf<N>;
	return spec.response.parse(json) as ResponseOf<N>;
}

/**
 * Task submit with a file: the multipart form the contract names next to its JSON form.
 * Parsed by the same Task schema as every other response.
 */
export async function submitTaskWithFile(
	params: { orgId: string; taskId: string },
	responseText: string | null,
	file: File,
): Promise<ResponseOf<"submitTask">> {
	const spec = ROUTES.submitTask;
	const path = fillPath(spec.path, params);
	let json: unknown;
	if (FIXTURE_MODE) {
		const fx = await loadFixtures();
		json = await fx.handle(
			"submitTask",
			params,
			{ response_text: responseText },
			undefined,
			file.name,
		);
	} else {
		const form = new FormData();
		if (responseText) form.set("response_text", responseText);
		form.set("file", file);
		const res = await fetch(apiUrl(path), {
			body: form,
			credentials: "include",
			method: "POST",
		});
		const raw = await res.json().catch(() => null);
		if (!res.ok) throw await toApiError(res.status, raw);
		json = raw;
	}
	return spec.response.parse(json);
}

/** The bytes of a document PDF (file_url or signed_pdf_url), for pdf.js or a download. */
export async function fetchPdf(url: string): Promise<Uint8Array> {
	if (FIXTURE_MODE) {
		const fx = await loadFixtures();
		return fx.pdfFor(url);
	}
	const res = await fetch(url.startsWith("/api/") ? apiUrl(url) : url, {
		credentials: "include",
	});
	if (!res.ok) throw new AccountsApiError(res.status, `HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * Opens a PDF in a new tab. The real API serves it with the session cookie, so a plain
 * link works; fixture mode builds the file in the page and opens it as a blob.
 */
export async function openPdf(url: string): Promise<void> {
	if (!FIXTURE_MODE) {
		window.open(
			url.startsWith("/api/") ? apiUrl(url) : url,
			"_blank",
			"noopener",
		);
		return;
	}
	// Opened before the await so the browser still counts it as the click's popup.
	const tab = window.open("", "_blank");
	const bytes = await fetchPdf(url);
	const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
	const href = URL.createObjectURL(blob);
	if (tab) tab.location.href = href;
	else window.location.href = href;
}
