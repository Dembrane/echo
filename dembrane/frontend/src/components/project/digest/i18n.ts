import { type CatalogModule, createCatalogHook } from "@/lib/lazyCatalog";

/** The digest screens' own catalog (./locales), off the portal's first load. */
export const useDigestCatalog = createCatalogHook(
	import.meta.glob<CatalogModule>("./locales/*.ts"),
);
