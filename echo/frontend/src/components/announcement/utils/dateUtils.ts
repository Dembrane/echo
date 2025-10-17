import { formatRelative } from "date-fns";
import { de, enUS, es, fr, nl } from "date-fns/locale";
import { useLanguage } from "@/hooks/useLanguage";

// Map of supported locales to date-fns locales
const localeMap = {
	"de-DE": de,
	"en-US": enUS,
	"es-ES": es,
	"fr-FR": fr,
	"nl-NL": nl,
} as const;

type SupportedLocale = keyof typeof localeMap;

export const formatDate = (
	date: string | Date | null | undefined,
	locale = "en-US",
): string => {
	if (!date) return "";

	const dateObj = typeof date === "string" ? new Date(date) : date;

	if (Number.isNaN(dateObj.getTime())) return "";

	const currentLocale =
		localeMap[locale as SupportedLocale] || localeMap["en-US"];

	return formatRelative(dateObj, new Date(), { locale: currentLocale });
};

export const useFormatDate = () => {
	const { i18n } = useLanguage();

	return (date: string | Date | null | undefined): string => {
		return formatDate(date, i18n.locale);
	};
};
