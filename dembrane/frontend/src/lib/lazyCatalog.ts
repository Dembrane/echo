import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";

/** What `import.meta.glob<CatalogModule>("./locales/*.ts")` returns for a feature catalog. */
export type CatalogModule = { messages: Record<string, string> };
export type CatalogLoaders = Record<string, () => Promise<CatalogModule>>;

/**
 * A feature that carries its own lingui catalog (its ./locales folder) loads it when one of
 * its screens opens. The main catalogs are bundled into the first load of the dashboard and
 * the participant portal, so strings kept in a feature catalog cost the portal nothing.
 * `pnpm messages:extract` and `messages:compile` write every catalog.
 *
 * The glob has to be written in the feature's own file (Vite resolves it there):
 *
 *   export const useThingCatalog = createCatalogHook(
 *     import.meta.glob<CatalogModule>("./locales/*.ts"),
 *   );
 *
 * The hook returns true once the current locale's strings are in; a locale without a
 * catalog reads the English one.
 */
export function createCatalogHook(catalogs: CatalogLoaders): () => boolean {
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

	return function useCatalog(): boolean {
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
	};
}
