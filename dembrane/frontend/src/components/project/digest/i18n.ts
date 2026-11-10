import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";

/**
 * The digest screens carry their own lingui catalog (./locales), loaded when one of them
 * opens, as the template picker's does (../templates/i18n.ts): the main catalogs are in
 * the participant portal's first load, these words are not.
 */
const catalogs = import.meta.glob<{ messages: Record<string, string> }>(
	"./locales/*.ts",
);
const loaded = new Set<string>();

async function loadCatalog(
	i18n: ReturnType<typeof useLingui>["i18n"],
	locale: string,
) {
	if (loaded.has(locale)) return;
	const loader =
		catalogs[`./locales/${locale}.ts`] ?? catalogs["./locales/en-US.ts"];
	if (!loader) return;
	const { messages } = await loader();
	i18n.load(locale, messages);
	loaded.add(locale);
}

/** Loads the digest catalog for the current locale; true once its strings are in. */
export function useDigestCatalog(): boolean {
	const { i18n } = useLingui();
	const locale = i18n.locale;
	const [ready, setReady] = useState(loaded.has(locale));
	useEffect(() => {
		let live = true;
		if (loaded.has(locale)) {
			setReady(true);
			return;
		}
		setReady(false);
		loadCatalog(i18n, locale).finally(() => {
			if (live) setReady(true);
		});
		return () => {
			live = false;
		};
	}, [i18n, locale]);
	return ready;
}
