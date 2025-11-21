import type React from "react";
import { Link, type LinkProps, useParams } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";

export const I18nLink: React.FC<LinkProps> = ({ to, ...props }) => {
	const { language } = useParams<{ language?: string }>();
	const { language: i18nLanguage } = useLanguage();

	const finalLanguage = language ?? i18nLanguage;

	const extractPathname = () => {
		if (typeof to === "string") {
			return to;
		}
		if (typeof to === "object" && to !== null && "pathname" in to) {
			return (to.pathname as string | undefined) ?? undefined;
		}
		return undefined;
	};

	const pathname = extractPathname();
	const isRelative = pathname
		? pathname === ".." ||
			pathname === "." ||
			pathname.startsWith("../") ||
			pathname.startsWith("./")
		: to.toString() === "..";

	if (isRelative) {
		return <Link to={to} {...props} />;
	}

	const hasLanguagePrefix = pathname
		? SUPPORTED_LANGUAGES.some(
				(lang) => pathname === `/${lang}` || pathname.startsWith(`/${lang}/`),
			)
		: SUPPORTED_LANGUAGES.some((lang) => to.toString().startsWith(`/${lang}`));

	if (hasLanguagePrefix) {
		return <Link to={to} {...props} />;
	}

	const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
	const modifiedTo =
		typeof to === "string"
			? `${languagePrefix}${to}`
			: { ...to, pathname: `${languagePrefix}${to.pathname ?? ""}` };

	return <Link to={modifiedTo} {...props} />;
};
