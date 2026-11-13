import { SUPPORTED_LANGUAGES } from "@/config";

export type SupportedLocale = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * The interface locale for a project language ("nl" is "nl-NL"), English for any other.
 * The dashboard's portal preview and the portal's preview frame both open the portal in it.
 */
export const localeForLanguage = (
	language: string | null | undefined,
): SupportedLocale =>
	SUPPORTED_LANGUAGES.find((locale) => locale.split("-")[0] === language) ??
	"en-US";
