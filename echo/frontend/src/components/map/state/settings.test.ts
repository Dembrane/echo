// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAP_SETTINGS,
	MAP_SETTINGS_STORAGE_KEY,
	MAP_SETTINGS_VERSION,
	migrateMapSettings,
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

const store = (value: unknown) =>
	window.localStorage.setItem(MAP_SETTINGS_STORAGE_KEY, JSON.stringify(value));

describe("map settings", () => {
	it("starts from DDW's panels, Type colouring and the deployment budgets", () => {
		expect(readMapSettings()).toEqual({
			autoFactCheckClaims: false,
			colorBy: "type",
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
			types: null,
		});
	});

	it("persists under dembrane-map-settings with its version and reads back", () => {
		updateMapSettings({ colorBy: "factCheck", showShowcase: true });
		resetMapSettingsForTests();
		const settings = readMapSettings();
		expect(settings.colorBy).toBe("factCheck");
		expect(settings.showShowcase).toBe(true);
		expect(
			JSON.parse(window.localStorage.getItem(MAP_SETTINGS_STORAGE_KEY) ?? "{}"),
		).toMatchObject({ colorBy: "factCheck", version: MAP_SETTINGS_VERSION });
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

		store({ colorBy: "rainbow", showLegend: true, showTree: "yes" });
		const settings = readMapSettings();
		expect(settings.colorBy).toBe("type");
		expect(settings.showLegend).toBe(true);
		expect(settings.showTree).toBe(true);
	});
});

describe("settings migration", () => {
	it.each(["none", "valence", "factCheck"] as const)(
		"keeps a version 1 colour mode of %s and every panel choice",
		(colorBy) => {
			store({
				autoFactCheckClaims: true,
				colorBy,
				darkMode: true,
				showClusters: false,
				showExplore: false,
				showLegend: true,
				showShowcase: true,
				showSpotlight: false,
				showTree: false,
			});
			expect(readMapSettings()).toEqual({
				autoFactCheckClaims: true,
				colorBy,
				darkMode: true,
				edgeLimit: null,
				nodeLimit: null,
				showClusters: false,
				showExplore: false,
				showLegend: true,
				showRelationships: false,
				showShowcase: true,
				showSpotlight: false,
				showTree: false,
				types: null,
			});
		},
	);

	it("keeps custom budgets, relationships and saved types", () => {
		store({
			colorBy: "type",
			edgeLimit: 900,
			nodeLimit: 300,
			showRelationships: true,
			types: ["tension", "bogus", "tension", "argument"],
			version: 2,
		});
		const settings = readMapSettings();
		expect(settings.nodeLimit).toBe(300);
		expect(settings.edgeLimit).toBe(900);
		expect(settings.showRelationships).toBe(true);
		expect(settings.types).toEqual(["tension", "argument"]);
	});

	it("keeps an inconsistent budget pair as saved; resolution adjusts it where applied", () => {
		expect(migrateMapSettings({ edgeLimit: 10, nodeLimit: 300 })).toMatchObject(
			{
				edgeLimit: 10,
				nodeLimit: 300,
			},
		);
	});

	it.each([0, -1, 1.5, "200", null, Number.NaN])(
		"drops a budget of %s to follow the default",
		(value) => {
			expect(
				migrateMapSettings({ edgeLimit: value, nodeLimit: value }),
			).toMatchObject({ edgeLimit: null, nodeLimit: null });
		},
	);

	it("reads a newer version's known fields", () => {
		store({ colorBy: "valence", nodeLimit: 120, version: 99 });
		expect(readMapSettings()).toMatchObject({
			colorBy: "valence",
			nodeLimit: 120,
		});
	});
});
