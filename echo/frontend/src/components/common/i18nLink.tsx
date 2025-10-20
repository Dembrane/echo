import type React from "react";
import { Link, type LinkProps, useParams } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";

export const I18nLink: React.FC<LinkProps> = ({ to, ...props }) => {
	const { language } = useParams<{ language?: string }>();
	const { language: i18nLanguage } = useLanguage();

	const finalLanguage = language ?? i18nLanguage;

	if (to.toString() === "..") {
		return <Link to={to} {...props} />;
	}

	// Check if URL already starts with a supported language prefix
	const hasLanguagePrefix = SUPPORTED_LANGUAGES.some((lang) =>
		to.toString().startsWith(`/${lang}`),
	);

	if (hasLanguagePrefix) {
		return <Link to={to} {...props} />;
	}

	const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
	const modifiedTo = typeof to === "string" ? `${languagePrefix}${to}` : to;

	return <Link to={modifiedTo} {...props} />;
};
