import { describe, expect, it } from "vitest";

import {
	projectLanguageForForm,
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
