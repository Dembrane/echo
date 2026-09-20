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
	it("starts from DDW's panels, conversation colouring and the deployment budgets", () => {
		expect(readMapSettings()).toEqual({
			autoFactCheckClaims: false,
			colorBy: "conversation",
			darkMode: false,
			edgeLimit: null,
			nodeLimit: null,
			showClusters: true,
			showExplore: true,
			showLegend: true,
			showRelationships: false,
			showShowcase: false,
			showSpotlight: true,
			showTree: true,
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
		expect(settings.colorBy).toBe("conversation");
		expect(settings.showLegend).toBe(true);
		expect(settings.showTree).toBe(true);
	});
});

describe("settings migration", () => {
	it.each(["valence", "factCheck"] as const)(
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
			});
		},
	);

	it("keeps custom budgets and relationships but ignores saved types", () => {
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
		expect(settings).not.toHaveProperty("types");
	});

	it("moves a host who never picked a colour onto the conversations", () => {
		// Neutral was the default before version 4, so a saved "none" is the
		// old default rather than a choice. Retired type colouring resolved to
		// neutral and travels the same way.
		store({ colorBy: "none", version: 3 });
		expect(readMapSettings().colorBy).toBe("conversation");
		store({ colorBy: "type", version: 2 });
		expect(readMapSettings().colorBy).toBe("conversation");
	});

	it("shows the legend to a host who never turned it on", () => {
		// Off was the default before version 5, so a saved false is the old
		// default rather than a choice. A host who turned it off since keeps
		// the quiet map.
		store({ showLegend: false, version: 4 });
		expect(readMapSettings().showLegend).toBe(true);
		store({ showLegend: false, version: MAP_SETTINGS_VERSION });
		expect(readMapSettings().showLegend).toBe(false);
	});

	it("keeps neutral once a host has chosen it", () => {
		store({ colorBy: "none", version: MAP_SETTINGS_VERSION });
		expect(readMapSettings().colorBy).toBe("none");
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
