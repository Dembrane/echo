import { SUPPORTED_LANGUAGES } from "@/config";

/** A project stores the bare ISO 639-1 code of a supported locale: `en-US` → `en`. */
type Iso639<Locale extends string> = Locale extends `${infer Code}-${string}`
	? Code
	: Locale;

export type ProjectLanguageCode = Iso639<(typeof SUPPORTED_LANGUAGES)[number]>;

export const PROJECT_LANGUAGE_CODES: readonly ProjectLanguageCode[] =
	SUPPORTED_LANGUAGES.map(
		(locale) => locale.split("-")[0] as ProjectLanguageCode,
	);

const PROJECT_LANGUAGE_SET = new Set<string>(PROJECT_LANGUAGE_CODES);

/** The editor needs a concrete locale even for legacy `multi` and null rows. */
export const projectLanguageForForm = (
	stored: string | null | undefined,
): ProjectLanguageCode =>
	PROJECT_LANGUAGE_SET.has(stored ?? "")
		? (stored as ProjectLanguageCode)
		: "en";

/** Omit an unchanged fallback so an unrelated save preserves `multi` or null. */
export const projectLanguageForUpdate = (
	value: ProjectLanguageCode,
	dirty: boolean,
): ProjectLanguageCode | undefined => (dirty ? value : undefined);
