import type { Locale } from "date-fns";
import { cs, de, enUS, es, fr, it, nl, uk } from "date-fns/locale";

// UI languages mapped to their date-fns locales.
const localeMap: Record<string, Locale> = {
	"cs-CZ": cs,
	"de-DE": de,
	"en-US": enUS,
	"es-ES": es,
	"fr-FR": fr,
	"it-IT": it,
	"nl-NL": nl,
	"uk-UA": uk,
};

export const dateFnsLocale = (language: string): Locale =>
	localeMap[language] ?? enUS;
