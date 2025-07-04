import { formatRelative } from "date-fns";
import { enUS, nl, de, fr, es } from "date-fns/locale";
import { useLanguage } from "@/hooks/useLanguage";

// Map of supported locales to date-fns locales
const localeMap = {
  "en-US": enUS,
  "nl-NL": nl,
  "de-DE": de,
  "fr-FR": fr,
  "es-ES": es,
} as const;

type SupportedLocale = keyof typeof localeMap;

export const formatDate = (
  date: string | Date | null | undefined,
  locale: string = "en-US",
): string => {
  if (!date) return "";

  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) return "";

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
