import { formatRelative } from "date-fns";
import { useLanguage } from "@/hooks/useLanguage";
import { dateFnsLocale } from "@/lib/dateLocale";

export const formatDate = (
	date: string | Date | null | undefined,
	locale = "en-US",
): string => {
	if (!date) return "";

	const dateObj = typeof date === "string" ? new Date(date) : date;

	if (Number.isNaN(dateObj.getTime())) return "";

	return formatRelative(dateObj, new Date(), { locale: dateFnsLocale(locale) });
};

export const useFormatDate = () => {
	const { i18n } = useLanguage();

	return (date: string | Date | null | undefined): string => {
		return formatDate(date, i18n.locale);
	};
};
