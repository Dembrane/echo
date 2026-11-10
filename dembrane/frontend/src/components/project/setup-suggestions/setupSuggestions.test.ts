import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/errors/read";
import {
	addTerms,
	failureCause,
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

describe("why a request failed", () => {
	it.each([
		[402, "budget"],
		[503, "unavailable"],
		[429, "rate_limited"],
		[422, "invalid"],
		[403, "forbidden"],
		[500, "error"],
	])("%s is %s", (status, cause) => {
		expect(failureCause(new ApiRequestError(status, {}))).toBe(cause);
	});
	it("a fetch that never reached the server is network", () => {
		expect(failureCause(new TypeError("Failed to fetch"))).toBe("network");
	});
});
