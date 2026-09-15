import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { isObjectType, OBJECT_TYPES } from "../attributes";
import { isColorBy } from "../state/settings";
import type { ColorBy, ObjectType } from "../types";

export type MapView = "list" | "map";

/** Map state that lives in the URL so it is shareable and survives reload. */
export type MapUrlState = {
	/** Null: not in the URL. An empty list: no type selected. */
	types: ObjectType[] | null;
	/** A result scope, such as one deduplication result. */
	scope: string | null;
	colorBy: ColorBy | null;
	view: MapView | null;
};

export const MAP_URL_PARAMS = {
	colorBy: "colorBy",
	scope: "scope",
	types: "types",
	view: "view",
} as const;

export function parseMapSearchParams(params: URLSearchParams): MapUrlState {
	const rawTypes = params.get(MAP_URL_PARAMS.types);
	const types =
		rawTypes === null
			? null
			: OBJECT_TYPES.filter((type) =>
					rawTypes
						.split(",")
						.map((item) => item.trim())
						.filter(isObjectType)
						.includes(type),
				);
	const colorBy = params.get(MAP_URL_PARAMS.colorBy);
	const view = params.get(MAP_URL_PARAMS.view);
	return {
		colorBy: isColorBy(colorBy) ? colorBy : null,
		scope: params.get(MAP_URL_PARAMS.scope) || null,
		types,
		view: view === "list" || view === "map" ? view : null,
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
	if ("types" in patch) {
		set(
			MAP_URL_PARAMS.types,
			patch.types
				? OBJECT_TYPES.filter((type) => patch.types?.includes(type)).join(",")
				: null,
		);
	}
	if ("scope" in patch) set(MAP_URL_PARAMS.scope, patch.scope ?? null);
	if ("colorBy" in patch) set(MAP_URL_PARAMS.colorBy, patch.colorBy ?? null);
	if ("view" in patch) set(MAP_URL_PARAMS.view, patch.view ?? null);
	return next;
}

/** The URL patch that opens one deduplication result: its output only. */
export const deduplicationResultScope = (
	resultScope: string,
): Partial<MapUrlState> => ({
	scope: resultScope,
	types: ["deduplicated_argument"],
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
