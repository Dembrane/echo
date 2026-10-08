import { i18n } from "@lingui/core";
import { setDefaultOptions } from "date-fns";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { dateFnsLocale } from "@/lib/dateLocale";
import { readStoredLanguage } from "@/lib/language";

export const defaultLanguage = "en-US";

// English is the fallback every screen can render at once; each other language is its own
// chunk, fetched when it is chosen, so the participant portal's first load carries one
// catalog instead of eight.
import { messages as enMessages } from "../locales/en-US";

// Every date-fns call ("5 minutes ago", "today at 3:41 PM") follows the UI language.
i18n.on("change", () => {
	setDefaultOptions({ locale: dateFnsLocale(i18n.locale) });
});

i18n.load("en-US", enMessages);
i18n.activate(defaultLanguage);

const catalogs = import.meta.glob<{ messages: Record<string, string> }>([
	"../locales/*.ts",
	"!../locales/en-US.ts",
]);
const loaded = new Set<string>(["en-US"]);

/** Loads a language's catalog (once) and makes it the active one. */
export async function activateLanguage(locale: string): Promise<void> {
	if (!loaded.has(locale)) {
		const loader = catalogs[`../locales/${locale}.ts`];
		if (!loader) {
			i18n.activate(defaultLanguage);
			return;
		}
		const { messages } = await loader();
		i18n.load(locale, messages);
		loaded.add(locale);
	}
	i18n.activate(locale);
}

// Start fetching the saved language right away, so it is usually there by first render.
const stored = readStoredLanguage();
const storedReady =
	stored && stored !== defaultLanguage
		? activateLanguage(stored).catch(() => {})
		: Promise.resolve();

export const useLanguage = () => {
	const params = useParams();
	// URL prefix wins (shareable/explicit); otherwise restore the saved choice.
	const language =
		params.language ?? readStoredLanguage() ?? i18n.locale ?? defaultLanguage;
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let live = true;
		const supported = SUPPORTED_LANGUAGES.map((l) => l.toString()).includes(
			language,
		);
		if (!supported) console.log("Unsupported language", language);
		// The screen waits (I18nProvider shows its overlay) until the catalog is in, so
		// explicit message ids never render raw.
		if (!loaded.has(supported ? language : defaultLanguage)) setLoading(true);
		storedReady
			.then(() => activateLanguage(supported ? language : defaultLanguage))
			.catch(() => i18n.activate(defaultLanguage))
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [language]);

	return {
		i18n,
		iso639_1: language.split("-")[0],
		language,
		loading,
	};
};
