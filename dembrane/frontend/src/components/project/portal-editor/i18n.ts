import { type CatalogModule, createCatalogHook } from "@/lib/lazyCatalog";

/**
 * The project settings screens' own catalog (./locales): the portal editor, Brief and
 * Manage's Advanced tab (ECHO-1060), off the portal's first load.
 */
export const useSettingsCatalog = createCatalogHook(
	import.meta.glob<CatalogModule>("./locales/*.ts"),
);
