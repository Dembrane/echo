import { describe, expect, it } from "vitest";
import {
	addTerms,
	hasTerm,
	MAX_KEY_TERMS,
	removeTerm,
	splitTerms,
} from "./setupSuggestions";

describe("the key terms value", () => {
	it("splits, dedupes case-insensitively and keeps the first spelling", () => {
		expect(splitTerms(" GGD, Klokgebouw ,, ggd")).toEqual([
			"GGD",
			"Klokgebouw",
		]);
	});
	it("adds without repeats and never past the cap", () => {
		expect(addTerms("GGD", ["ggd", "Strijp-S"])).toBe("GGD, Strijp-S");
		const full = Array.from({ length: MAX_KEY_TERMS }, (_, i) => `T${i}`).join(
			", ",
		);
		expect(addTerms(full, ["One more"])).toBe(full);
	});
	it("removes and finds case-insensitively", () => {
		expect(removeTerm("GGD, Strijp-S", "ggd")).toBe("Strijp-S");
		expect(hasTerm("GGD, Strijp-S", "strijp-s")).toBe(true);
	});
});
