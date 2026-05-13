import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * Search-term state synced to a `?search=` query param.
 *
 * Shareable + reload-stable like the settings tab state. Trimmed empty
 * strings drop the param entirely so URLs stay clean.
 *
 * Usage:
 *     const [search, setSearch] = useUrlSearch();
 */
export function useUrlSearch(
	paramName = "search",
): [string, (value: string) => void] {
	const [searchParams, setSearchParams] = useSearchParams();
	const current = searchParams.get(paramName) ?? "";

	const setSearch = useCallback(
		(value: string) => {
			const next = new URLSearchParams(searchParams);
			if (value) {
				next.set(paramName, value);
			} else {
				next.delete(paramName);
			}
			setSearchParams(next, { replace: true });
		},
		[paramName, searchParams, setSearchParams],
	);

	return [current, setSearch];
}
