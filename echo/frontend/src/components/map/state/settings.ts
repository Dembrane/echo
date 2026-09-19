import { useSyncExternalStore } from "react";
import { COLOR_BY_OPTIONS } from "../attributes";
import { isPositiveInteger } from "../budgets";
import type { ColorBy } from "../types";

export const MAP_SETTINGS_STORAGE_KEY = "dembrane-map-settings";

/**
 * Version 1 had panels, colour mode, auto fact-check and dark mode, without
 * a version field. Version 2 adds the Type colour mode, custom budgets, the
 * Relationships control and the saved type selection. Version 3 retires the
 * type selection and resolves Type colouring to neutral.
 */
export const MAP_SETTINGS_VERSION = 3;

export type MapSettings = {
	showExplore: boolean;
	showShowcase: boolean;
	showSpotlight: boolean;
	showTree: boolean;
	showClusters: boolean;
	showLegend: boolean;
	autoFactCheckClaims: boolean;
	darkMode: boolean;
	colorBy: ColorBy;
	/** Custom node budget; null follows the deployment default. */
	nodeLimit: number | null;
	/** Custom visible-edge budget; null follows the deployment default. */
	edgeLimit: number | null;
	showRelationships: boolean;
};

export const DEFAULT_MAP_SETTINGS: MapSettings = {
	autoFactCheckClaims: false,
	colorBy: "none",
	darkMode: false,
	edgeLimit: null,
	nodeLimit: null,
	showClusters: true,
	showExplore: true,
	showLegend: false,
	showRelationships: false,
	showShowcase: false,
	showSpotlight: true,
	showTree: true,
};

const COLOR_BY: ReadonlySet<string> = new Set(COLOR_BY_OPTIONS);

export const isColorBy = (value: unknown): value is ColorBy =>
	typeof value === "string" && COLOR_BY.has(value);

const BOOLEAN_KEYS = [
	"showExplore",
	"showShowcase",
	"showSpotlight",
	"showTree",
	"showClusters",
	"showLegend",
	"autoFactCheckClaims",
	"darkMode",
	"showRelationships",
] as const;

/**
 * Stored settings of any version over the current defaults. Every value a
 * host chose that is still valid is kept, including custom budgets; the pair
 * is checked against the deployment bounds where it is applied.
 */
export function migrateMapSettings(
	stored: Record<string, unknown>,
): MapSettings {
	const settings: MapSettings = { ...DEFAULT_MAP_SETTINGS };
	for (const key of BOOLEAN_KEYS) {
		if (typeof stored[key] === "boolean") settings[key] = stored[key];
	}
	if (isColorBy(stored.colorBy)) {
		// Type colouring belonged to the mixed-object surface. Old saved values
		// now resolve to the neutral argument map.
		settings.colorBy = stored.colorBy === "type" ? "none" : stored.colorBy;
	}
	if (isPositiveInteger(stored.nodeLimit))
		settings.nodeLimit = stored.nodeLimit;
	if (isPositiveInteger(stored.edgeLimit))
		settings.edgeLimit = stored.edgeLimit;
	return settings;
}

/** Stored settings over the defaults; anything unreadable falls back. */
export function readMapSettings(): MapSettings {
	let raw: string | null = null;
	try {
		raw = globalThis.localStorage?.getItem(MAP_SETTINGS_STORAGE_KEY) ?? null;
	} catch {
		return { ...DEFAULT_MAP_SETTINGS };
	}
	if (!raw) return { ...DEFAULT_MAP_SETTINGS };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_MAP_SETTINGS };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...DEFAULT_MAP_SETTINGS };
	}
	return migrateMapSettings(parsed as Record<string, unknown>);
}

/** Writes the settings; a blocked or full storage keeps them in memory only. */
export function writeMapSettings(settings: MapSettings): void {
	try {
		globalThis.localStorage?.setItem(
			MAP_SETTINGS_STORAGE_KEY,
			JSON.stringify({ ...settings, version: MAP_SETTINGS_VERSION }),
		);
	} catch {
		// Private windows and blocked storage: the page still works.
	}
}

// One shared store per page load so the settings menu, panels and legend
// agree without prop drilling.
let current: MapSettings | null = null;
const listeners = new Set<() => void>();

const getSnapshot = (): MapSettings => {
	if (!current) current = readMapSettings();
	return current;
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export function updateMapSettings(patch: Partial<MapSettings>): void {
	const next = {
		...getSnapshot(),
		...patch,
	};
	if (patch.colorBy === "type") next.colorBy = "none";
	current = next;
	writeMapSettings(next);
	for (const listener of listeners) listener();
}

/** Test helper: forget the in-memory settings so the next read hits storage. */
export function resetMapSettingsForTests(): void {
	current = null;
}

export function useMapSettings(): [
	MapSettings,
	(patch: Partial<MapSettings>) => void,
] {
	const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return [settings, updateMapSettings];
}
