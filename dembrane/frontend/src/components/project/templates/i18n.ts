import { type CatalogModule, createCatalogHook } from "@/lib/lazyCatalog";

/** The template picker's own catalog (./locales): sixteen templates' words, off the portal's first load. */
export const useTemplatesCatalog = createCatalogHook(
	import.meta.glob<CatalogModule>("./locales/*.ts"),
);
