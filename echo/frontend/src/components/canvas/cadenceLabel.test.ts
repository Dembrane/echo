import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { canvasCadenceLabel } from "./cadenceLabel";

i18n.load("en-US", {});
i18n.activate("en-US");

describe("canvasCadenceLabel", () => {
	it("describes static canvases honestly", () => {
		expect(canvasCadenceLabel({ cadence_minutes: null })).toBe(
			"Does not update on its own.",
		);
		expect(canvasCadenceLabel({ cadence_minutes: 0 })).toBe(
			"Does not update on its own.",
		);
	});

	it("uses the configured cadence when the canvas loops", () => {
		expect(canvasCadenceLabel({ cadence_minutes: 15 })).toBe(
			"Updates every 15 minutes.",
		);
	});
});
