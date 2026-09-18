export const PROJECT_LANGUAGE_CODES = [
	"en",
	"nl",
	"de",
	"fr",
	"es",
	"it",
	"uk",
	"cs",
] as const;

export type ProjectLanguageCode = (typeof PROJECT_LANGUAGE_CODES)[number];

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
