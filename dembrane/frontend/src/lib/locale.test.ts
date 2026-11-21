import { describe, expect, it } from "vitest";
import { PROJECT_LANGUAGE_CODES } from "@/components/project/projectLanguage";
import { SUPPORTED_LANGUAGES } from "@/config";
import { localeForLanguage } from "./locale";

describe("localeForLanguage", () => {
	it("gives every project language its interface locale", () => {
		expect(PROJECT_LANGUAGE_CODES.map(localeForLanguage)).toEqual([
			...SUPPORTED_LANGUAGES,
		]);
		expect(localeForLanguage("nl")).toBe("nl-NL");
		expect(localeForLanguage("uk")).toBe("uk-UA");
	});
	it("is English for anything else", () => {
		for (const v of ["multi", "pt", "", null, undefined, "nl-NL"])
			expect(localeForLanguage(v)).toBe("en-US");
	});
});
