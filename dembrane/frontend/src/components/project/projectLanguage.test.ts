import { describe, expect, it } from "vitest";

import { SUPPORTED_LANGUAGES } from "@/config";
import {
	projectLanguageForForm,
	projectLanguageForLocale,
	projectLanguageForUpdate,
} from "./projectLanguage";

describe("project language form boundary", () => {
	it.each(["multi", null, undefined, "unknown"])(
		"shows English for unsupported stored value %s",
		(stored) => {
			expect(projectLanguageForForm(stored)).toBe("en");
		},
	);

	it("preserves a stored fallback until the host changes the field", () => {
		expect(projectLanguageForUpdate("en", false)).toBeUndefined();
		expect(projectLanguageForUpdate("nl", true)).toBe("nl");
	});

	it.each(["en", "nl", "de", "fr", "es", "it", "uk", "cs"] as const)(
		"accepts concrete language %s",
		(language) => {
			expect(projectLanguageForForm(language)).toBe(language);
		},
	);
});

describe("a new project's language from the dashboard's locale", () => {
	it.each([
		["en-US", "en"],
		["nl-NL", "nl"],
		["de-DE", "de"],
		["fr-FR", "fr"],
		["es-ES", "es"],
		["it-IT", "it"],
		["uk-UA", "uk"],
		["cs-CZ", "cs"],
	] as const)("%s creates a project in %s", (locale, language) => {
		expect(projectLanguageForLocale(locale)).toBe(language);
	});

	it("covers every locale the dashboard offers", () => {
		for (const locale of SUPPORTED_LANGUAGES)
			expect(projectLanguageForLocale(locale)).toBe(locale.slice(0, 2));
	});

	it.each(["pt-BR", "", null, undefined, "multi"])(
		"falls back to English for %s",
		(locale) => {
			expect(projectLanguageForLocale(locale)).toBe("en");
		},
	);
});
