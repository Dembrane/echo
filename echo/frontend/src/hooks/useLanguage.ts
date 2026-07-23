import { i18n } from "@lingui/core";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { readStoredLanguage, storeLanguage } from "@/lib/language";

export const defaultLanguage = "en-US";

import { messages as deMessages } from "../locales/de-DE";
import { messages as enMessages } from "../locales/en-US";
import { messages as esMessages } from "../locales/es-ES";
import { messages as frMessages } from "../locales/fr-FR";
import { messages as itMessages } from "../locales/it-IT";
import { messages as nlMessages } from "../locales/nl-NL";
import { messages as ukMessages } from "../locales/uk-UA";
import { messages as csMessages } from "../locales/cs-CZ";

i18n.load({
	"de-DE": deMessages,
	"en-US": enMessages,
	"es-ES": esMessages,
	"fr-FR": frMessages,
	"it-IT": itMessages,
	"nl-NL": nlMessages,
	"uk-UA": ukMessages,
	"cs-CZ": csMessages,
});

const normalizeLanguage = (langParam: string | null): string | null => {
	if (!langParam) return null;
	const normalized = langParam.trim();
	// Check exact match first (case-insensitive)
	const exactMatch = SUPPORTED_LANGUAGES.find(
		(l) => l.toLowerCase() === normalized.toLowerCase()
	);
	if (exactMatch) return exactMatch;

	// Check 2-letter prefix match (e.g. "de" or "de-CH" -> "de-DE")
	const prefix = normalized.split("-")[0].toLowerCase();
	const prefixMatch = SUPPORTED_LANGUAGES.find(
		(l) => l.split("-")[0].toLowerCase() === prefix
	);
	if (prefixMatch) return prefixMatch;

	return null;
};

// Seed from the saved preference so a prefix-less entry doesn't flash English.
i18n.activate(readStoredLanguage() ?? defaultLanguage);

export const useLanguage = () => {
	const params = useParams();
	let searchParams: URLSearchParams | null = null;
	try {
		const [sParams] = useSearchParams();
		searchParams = sParams;
	} catch (e) {
		if (typeof window !== "undefined") {
			searchParams = new URLSearchParams(window.location.search);
		}
	}

	const queryLanguageRaw = searchParams
		? (searchParams.get("portal_language") ||
			searchParams.get("language") ||
			searchParams.get("lang") ||
			searchParams.get("locale"))
		: null;
	const queryLanguage = normalizeLanguage(queryLanguageRaw);

	// URL prefix wins (shareable/explicit); query param is next; otherwise restore the saved choice.
	const language =
		params.language ??
		queryLanguage ??
		readStoredLanguage() ??
		i18n.locale ??
		defaultLanguage;
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if ([...SUPPORTED_LANGUAGES.map((l) => l.toString())].includes(language)) {
			i18n.activate(language);
			storeLanguage(language);
		} else {
			console.log("Unsupported language", language);
			i18n.activate(defaultLanguage);
		}
		setLoading(false);
	}, [language]);

	return {
		i18n,
		iso639_1: language.split("-")[0],
		language,
		loading,
	};
};
