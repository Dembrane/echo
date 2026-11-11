import { i18n } from "@lingui/core";
import { beforeEach, describe, expect, it } from "vitest";
import { messages as de } from "@/locales/de-DE";
import { messages as nl } from "@/locales/nl-NL";
import {
	formatDuration,
	formatDurationFromHours,
	formatDurationFromSeconds,
} from "./time";

beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

describe("formatDurationFromSeconds", () => {
	it("rounds to hundredths of an hour, as the usage API does", () => {
		// The usage API reports 160 s as 0.04 h.
		expect(formatDurationFromSeconds(160)).toBe(formatDurationFromHours(0.04));
		expect(formatDurationFromSeconds(160)).toBe("2 min");
	});
	it("keeps whole limits and empty meters", () => {
		expect(formatDurationFromSeconds(18000)).toBe("5h");
		expect(formatDurationFromSeconds(7800)).toBe("2h 10m");
		expect(formatDurationFromSeconds(0)).toBe("0 min");
	});
});

describe("formatDurationFromHours", () => {
	it("reads as it always has", () => {
		expect(formatDurationFromHours(0)).toBe("0 min");
		expect(formatDurationFromHours(null)).toBe("0 min");
		expect(formatDurationFromHours(Number.NaN)).toBe("0 min");
		expect(formatDurationFromHours(0.001)).toBe("1 min");
		expect(formatDurationFromHours(0.73)).toBe("44 min");
		expect(formatDurationFromHours(1)).toBe("1h");
		expect(formatDurationFromHours(1.5)).toBe("1h 30m");
		expect(formatDurationFromHours(2.17)).toBe("2h 10m");
	});
});

describe("formatDuration", () => {
	it("keeps seconds under an hour at second precision", () => {
		expect(formatDuration(0, "second")).toBe("0 s");
		expect(formatDuration(15, "second")).toBe("15 s");
		expect(formatDuration(120, "second")).toBe("2 min");
		expect(formatDuration(225, "second")).toBe("3 min 45 s");
		expect(formatDuration(3602, "second")).toBe("1h");
		expect(formatDuration(5459, "second")).toBe("1h 30m");
	});

	it("keeps seconds everywhere at exact precision", () => {
		expect(formatDuration(3602, "exact")).toBe("1h 0m 2s");
		expect(formatDuration(5430, "exact")).toBe("1h 30m 30s");
		expect(formatDuration(1801, "exact")).toBe("30 min 1 s");
	});

	it("translates every unit", () => {
		i18n.loadAndActivate({ locale: "nl-NL", messages: nl });
		expect(formatDuration(5430, "exact")).toBe("1u 30m 30s");
		expect(formatDuration(1801, "exact")).toBe("30 min 1 s");
		i18n.loadAndActivate({ locale: "de-DE", messages: de });
		expect(formatDuration(5430, "exact")).toBe("1 Std. 30 Min. 30 s");
		expect(formatDurationFromHours(0.5)).toBe("30 Min.");
	});
});
