import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ErrorCode } from "./catalog/index.gen";
import type { ErrorAction } from "./catalog/types.gen";
import { type ApiError, readApiError } from "./read";

/**
 * The one error presenter: turns anything a request threw into a short, friendly sentence
 * in the person's language and the one thing they can do about it. The API sends a code
 * (packages/core/src/catalog on the platform); the message for each code lives in
 * ./messages, loaded with the first error a screen shows so the participant portal's first
 * load never carries it. An unknown code, or no code at all, reads as the generic message
 * with the support action: raw backend text never reaches the screen.
 */
export interface PresentedError {
	readonly message: string;
	readonly action: ErrorAction;
	readonly code: string | null;
	readonly status: number | null;
	readonly params: Readonly<Record<string, unknown>>;
	/** Friendly message per failing form field, keyed by the field's dotted path. */
	readonly fields: Readonly<Record<string, string>>;
	/** Who to ask, for contact_admin, when the API knows. */
	readonly admin: { readonly name?: string; readonly email?: string } | null;
}

/**
 * Fallbacks in the main catalog, so an error still reads well when the message chunk has
 * not loaded (or failed to): one per action, one for no connection, one for the unknown.
 */
const FALLBACK: Record<ErrorAction | "network" | "unknown", MessageDescriptor> =
	{
		contact_admin: msg({
			id: "error.fallback.contact_admin",
			message:
				"You do not have permission to do this. Ask your admin for access.",
		}),
		contact_support: msg({
			id: "error.fallback.contact_support",
			message:
				"Something went wrong that we need to fix. Contact support and we will help.",
		}),
		fix_input: msg({
			id: "error.fallback.fix_input",
			message: "Something in the form needs a fix. Check it and try again.",
		}),
		network: msg({
			id: "error.fallback.network",
			message:
				"We could not reach dembrane. Check your internet connection and try again.",
		}),
		none: msg({
			id: "error.fallback.none",
			message: "This is not available.",
		}),
		retry: msg({
			id: "error.fallback.retry",
			message: "Something went wrong on our side. Try again in a moment.",
		}),
		sign_in: msg({
			id: "error.fallback.sign_in",
			message: "Your session has ended. Sign in again to continue.",
		}),
		unknown: msg({
			id: "error.fallback.unknown",
			message:
				"Something went wrong. Try again, and contact support if it keeps happening.",
		}),
		upgrade: msg({
			id: "error.fallback.upgrade",
			message: "Your current plan does not include this. Upgrade to use it.",
		}),
		wait: msg({
			id: "error.fallback.wait",
			message: "Too many tries in a short time. Wait a moment and try again.",
		}),
	};

type MessageTable = Partial<Record<ErrorCode, MessageDescriptor>>;

let table: MessageTable | null = null;
const loadedLocales = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

const localeCatalogs = import.meta.glob<{ messages: Record<string, string> }>(
	"./locales/*.ts",
);

/**
 * Loads the message table and the current locale's translations of it. Safe to call
 * often: each locale loads once, and a failed load leaves the fallbacks in place.
 */
export function loadErrorMessages(i18n: I18n): Promise<void> {
	const locale = i18n.locale || "en-US";
	if (table && loadedLocales.has(locale)) return Promise.resolve();
	const pending = inFlight.get(locale);
	if (pending) return pending;
	const load = (async () => {
		const loader =
			localeCatalogs[`./locales/${locale}.ts`] ??
			localeCatalogs["./locales/en-US.ts"];
		const [mod, catalog] = await Promise.all([
			import("./messages"),
			loader ? loader() : Promise.resolve({ messages: {} }),
		]);
		table = mod.ERROR_MESSAGES;
		i18n.load(locale, catalog.messages);
		loadedLocales.add(locale);
	})()
		.catch(() => {
			/* the fallbacks cover it; the next error tries again */
		})
		.finally(() => inFlight.delete(locale));
	inFlight.set(locale, load);
	return load;
}

/**
 * A descriptor with its values. Built as a variable, not an object literal in the call,
 * so lingui's extractor does not read the call as a new message.
 */
export function say(
	i18n: I18n,
	descriptor: MessageDescriptor,
	values: Readonly<Record<string, unknown>>,
): string {
	const withValues = {
		...descriptor,
		values: values as Record<string, unknown>,
	};
	return i18n._(withValues);
}

const str = (v: unknown) =>
	typeof v === "string" && v.trim() ? v.trim() : undefined;

function describe(
	i18n: I18n,
	info: ApiError,
): { message: string; action: ErrorAction } {
	if (info.network)
		return { action: "retry", message: i18n._(FALLBACK.network) };
	const known = info.code ? table?.[info.code as ErrorCode] : undefined;
	if (known && info.action)
		return {
			action: info.action,
			message: say(i18n, known, info.params),
		};
	// Before the table loads (or when its chunk failed), say it by the action the API sent.
	if (!table && info.code && info.action)
		return { action: info.action, message: i18n._(FALLBACK[info.action]) };
	// A code this build has no message for, or no code at all: never the backend's text.
	return { action: "contact_support", message: i18n._(FALLBACK.unknown) };
}

function fieldMessages(i18n: I18n, info: ApiError): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of info.fields) {
		if (!f.field || out[f.field]) continue;
		const known = table?.[f.code as ErrorCode];
		out[f.field] = say(i18n, known ?? FALLBACK.fix_input, f.params);
	}
	return out;
}

/**
 * Presents with whatever is loaded now: the specific message once the table has loaded,
 * the action's fallback before. Components re-render when loadErrorMessages settles.
 */
export function presentErrorNow(err: unknown, i18n: I18n): PresentedError {
	const info = readApiError(err);
	const { message, action } = describe(i18n, info);
	const adminName = str(info.params.admin_name);
	const adminEmail = str(info.params.admin_email);
	return {
		action,
		admin:
			adminName || adminEmail
				? {
						...(adminName && { name: adminName }),
						...(adminEmail && { email: adminEmail }),
					}
				: null,
		code: info.code,
		fields: fieldMessages(i18n, info),
		message,
		params: info.params,
		status: info.status,
	};
}

/** Loads the messages first, then presents: for toasts and other one-off notices. */
export async function presentError(
	err: unknown,
	i18n: I18n,
): Promise<PresentedError> {
	await loadErrorMessages(i18n);
	return presentErrorNow(err, i18n);
}
