import { useSyncExternalStore } from "react";
import type { ColorBy } from "../types";

export const MAP_SETTINGS_STORAGE_KEY = "dembrane-map-settings";

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
};

export const DEFAULT_MAP_SETTINGS: MapSettings = {
	autoFactCheckClaims: false,
	colorBy: "none",
	darkMode: false,
	showClusters: true,
	showExplore: true,
	showLegend: false,
	showShowcase: false,
	showSpotlight: true,
	showTree: true,
};

const COLOR_BY: ReadonlySet<ColorBy> = new Set([
	"none",
	"valence",
	"factCheck",
]);

const BOOLEAN_KEYS = [
	"showExplore",
	"showShowcase",
	"showSpotlight",
	"showTree",
	"showClusters",
	"showLegend",
	"autoFactCheckClaims",
	"darkMode",
] as const;

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
	if (!parsed || typeof parsed !== "object") return { ...DEFAULT_MAP_SETTINGS };

	const stored = parsed as Record<string, unknown>;
	const settings: MapSettings = { ...DEFAULT_MAP_SETTINGS };
	for (const key of BOOLEAN_KEYS) {
		if (typeof stored[key] === "boolean") settings[key] = stored[key];
	}
	if (COLOR_BY.has(stored.colorBy as ColorBy)) {
		settings.colorBy = stored.colorBy as ColorBy;
	}
	return settings;
}

/** Writes the settings; a blocked or full storage keeps them in memory only. */
export function writeMapSettings(settings: MapSettings): void {
	try {
		globalThis.localStorage?.setItem(
			MAP_SETTINGS_STORAGE_KEY,
			JSON.stringify(settings),
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
	const next = { ...getSnapshot(), ...patch };
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
