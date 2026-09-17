// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAP_SETTINGS,
	MAP_SETTINGS_STORAGE_KEY,
	readMapSettings,
	resetMapSettingsForTests,
	updateMapSettings,
	writeMapSettings,
} from "./settings";

beforeEach(() => {
	window.localStorage.clear();
	resetMapSettingsForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("map settings", () => {
	it("starts from DDW's defaults", () => {
		expect(readMapSettings()).toEqual({
			autoFactCheckClaims: false,
			colorBy: "none",
			darkMode: false,
			showClusters: true,
			showExplore: true,
			showLegend: false,
			showShowcase: false,
			showSpotlight: true,
			showTree: true,
		});
	});

	it("persists under dembrane-map-settings and reads back", () => {
		updateMapSettings({ colorBy: "factCheck", showShowcase: true });
		resetMapSettingsForTests();
		const settings = readMapSettings();
		expect(settings.colorBy).toBe("factCheck");
		expect(settings.showShowcase).toBe(true);
		expect(
			JSON.parse(window.localStorage.getItem(MAP_SETTINGS_STORAGE_KEY) ?? "{}"),
		).toMatchObject({ colorBy: "factCheck" });
	});

	it("falls back to defaults when storage cannot be read", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readMapSettings()).toEqual(DEFAULT_MAP_SETTINGS);
	});

	it("keeps working in memory when storage cannot be written", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		expect(() => writeMapSettings(DEFAULT_MAP_SETTINGS)).not.toThrow();
		expect(() => updateMapSettings({ darkMode: true })).not.toThrow();
	});

	it("ignores unreadable or invalid stored values", () => {
		window.localStorage.setItem(MAP_SETTINGS_STORAGE_KEY, "{not json");
		expect(readMapSettings()).toEqual(DEFAULT_MAP_SETTINGS);

		window.localStorage.setItem(
			MAP_SETTINGS_STORAGE_KEY,
			JSON.stringify({ colorBy: "rainbow", showLegend: true, showTree: "yes" }),
		);
		const settings = readMapSettings();
		expect(settings.colorBy).toBe("none");
		expect(settings.showLegend).toBe(true);
		expect(settings.showTree).toBe(true);
	});
});
