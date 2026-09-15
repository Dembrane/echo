import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { FactCheckState } from "../types";
import { deriveDisplayVerdict, getNodeStyleFromInputs } from "./nodeStyle";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const done = (verdict: "true" | "false" | "contested" | "unknown") =>
	({
		checkedAt: "",
		justification: "",
		sources: [],
		status: "done",
		verdict,
	}) satisfies FactCheckState;

describe("getNodeStyleFromInputs", () => {
	it("colours by valence with the brand palette", () => {
		expect(
			getNodeStyleFromInputs(
				{ valence: "positive" },
				{ colorBy: "valence" },
			).fill.toUpperCase(),
		).toBe("#1EFFA1");
		expect(
			getNodeStyleFromInputs({ valence: "negative" }, { colorBy: "valence" })
				.fill,
		).toBe("#FF9AA2");
	});

	it("greys arguments and pulses in-flight claims under fact-check colouring", () => {
		expect(
			getNodeStyleFromInputs({ kind: "argument" }, { colorBy: "factCheck" })
				.fill,
		).toBe("#9CA3AF");
		const processing = getNodeStyleFromInputs(
			{ factCheck: { startedAt: "", status: "processing" }, kind: "claim" },
			{ colorBy: "factCheck" },
		);
		expect(processing.fill.toUpperCase()).toBe("#4169E1");
		expect(processing.pulse).toBe(true);
	});

	it("drops the shadow filter in dark mode", () => {
		expect(
			getNodeStyleFromInputs({}, { colorBy: "none", darkMode: true }).filter,
		).toBe("none");
		expect(getNodeStyleFromInputs({}, { colorBy: "none" }).filter).toContain(
			"drop-shadow",
		);
	});
});

describe("deriveDisplayVerdict", () => {
	it("maps fact-check states to display verdicts", () => {
		expect(deriveDisplayVerdict(undefined)).toBe("unknown");
		expect(deriveDisplayVerdict({ status: "idle" })).toBe("unknown");
		expect(deriveDisplayVerdict(done("contested"))).toBe("contested");
	});
});
