import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { FactCheckState } from "../types";
import {
	deriveDisplayVerdict,
	getNodeStyleFromInputs,
	MAP_HIGHLIGHT,
	MAP_HIGHLIGHT_DARK,
	mapHighlight,
} from "./nodeStyle";

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

	it("keeps the graphite fills of the unassessed states in light mode", () => {
		expect(
			getNodeStyleFromInputs({ kind: "claim" }, { colorBy: "factCheck" }).fill,
		).toBe("#2D2D2C");
		expect(
			getNodeStyleFromInputs(
				{ factCheck: done("unknown"), kind: "claim" },
				{ colorBy: "factCheck" },
			).fill,
		).toBe("#2D2D2C");
	});

	it("lifts those graphite fills off the dark room background", () => {
		const soft = "#B4B3B1";
		expect(
			getNodeStyleFromInputs(
				{ kind: "claim" },
				{ colorBy: "factCheck", darkMode: true },
			).fill,
		).toBe(soft);
		expect(
			getNodeStyleFromInputs(
				{ factCheck: done("unknown"), kind: "claim" },
				{ colorBy: "factCheck", darkMode: true },
			).fill,
		).toBe(soft);
	});

	it("leaves the other fact-check fills alone in dark mode", () => {
		expect(
			getNodeStyleFromInputs(
				{ factCheck: done("true"), kind: "claim" },
				{ colorBy: "factCheck", darkMode: true },
			).fill.toUpperCase(),
		).toBe("#1EFFA1");
		expect(
			getNodeStyleFromInputs(
				{ kind: "argument" },
				{ colorBy: "factCheck", darkMode: true },
			).fill,
		).toBe("#9CA3AF");
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

describe("mapHighlight", () => {
	it("keeps institution blue on the light page", () => {
		expect(mapHighlight(false)).toBe(MAP_HIGHLIGHT);
		expect(mapHighlight(false).toUpperCase()).toBe("#4169E1");
	});

	it("uses the room screen's lifted blue in dark mode", () => {
		expect(mapHighlight(true)).toBe(MAP_HIGHLIGHT_DARK);
		expect(mapHighlight(true)).toBe("#7C9BFF");
	});
});

describe("deriveDisplayVerdict", () => {
	it("maps fact-check states to display verdicts", () => {
		expect(deriveDisplayVerdict(undefined)).toBe("unknown");
		expect(deriveDisplayVerdict({ status: "idle" })).toBe("unknown");
		expect(deriveDisplayVerdict(done("contested"))).toBe("contested");
	});
});
