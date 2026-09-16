import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { isColorBy } from "../state/settings";
import type { ColorBy } from "../types";

/** Map state that lives in the URL so it is shareable and survives reload. */
export type MapUrlState = {
	/** A result scope, such as one deduplication result. */
	scope: string | null;
	colorBy: ColorBy | null;
};

export const MAP_URL_PARAMS = {
	colorBy: "colorBy",
	scope: "scope",
} as const;

export function parseMapSearchParams(params: URLSearchParams): MapUrlState {
	const colorBy = params.get(MAP_URL_PARAMS.colorBy);
	return {
		colorBy: isColorBy(colorBy)
			? colorBy === "type"
				? "none"
				: colorBy
			: null,
		scope: params.get(MAP_URL_PARAMS.scope) || null,
	};
}

/** A copy of `params` with the patch applied; null removes a parameter. */
export function applyMapUrlState(
	params: URLSearchParams,
	patch: Partial<MapUrlState>,
): URLSearchParams {
	const next = new URLSearchParams(params);
	const set = (key: string, value: string | null) => {
		if (value === null) {
			next.delete(key);
		} else {
			next.set(key, value);
		}
	};
	if ("scope" in patch) set(MAP_URL_PARAMS.scope, patch.scope ?? null);
	if ("colorBy" in patch) {
		set(
			MAP_URL_PARAMS.colorBy,
			patch.colorBy === "type" ? "none" : (patch.colorBy ?? null),
		);
	}
	// Strip legacy controls when this page next writes its URL. They must not
	// restore the retired list or mixed-object surfaces on a shared link.
	next.delete("types");
	next.delete("view");
	return next;
}

/** The URL patch that opens one deduplication result: its output only. */
export const deduplicationResultScope = (
	resultScope: string,
): Partial<MapUrlState> => ({
	scope: resultScope,
});

/** Reads and replaces the Map's search parameters through the router. */
export function useMapUrlState(): [
	MapUrlState,
	(patch: Partial<MapUrlState>) => void,
] {
	const [searchParams, setSearchParams] = useSearchParams();
	const state = useMemo(
		() => parseMapSearchParams(searchParams),
		[searchParams],
	);
	const update = useCallback(
		(patch: Partial<MapUrlState>) =>
			setSearchParams((previous) => applyMapUrlState(previous, patch), {
				replace: true,
			}),
		[setSearchParams],
	);
	return [state, update];
}
