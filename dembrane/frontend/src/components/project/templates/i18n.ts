import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";

/**
 * The template picker carries its own lingui catalog (./locales), loaded when it opens, the
 * way the accounts screens do (features/accounts/i18n.tsx). The main catalogs are bundled
 * into the participant portal's first load, so sixteen templates' words kept here cost the
 * portal nothing. `pnpm messages:extract` and `messages:compile` write it with the others.
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

/** Loads the templates catalog for the current locale; true once its strings are in. */
export function useTemplatesCatalog(): boolean {
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
