/**
 * The loose list-query shape hooks accept from components: fields, filter, sort, search
 * and paging, in the form the Directus SDK used. Hooks translate the parts the API
 * understands into request parameters and keep the whole object in their query keys, so
 * components and cache keys stay as they were.
 */
export type ListQuery<Item> = {
	deep?: Record<string, unknown>;
	fields?: (keyof Item | string | Record<string, unknown>)[];
	filter?: Record<string, unknown>;
	limit?: number;
	offset?: number;
	search?: string;
	sort?: string | string[];
};
