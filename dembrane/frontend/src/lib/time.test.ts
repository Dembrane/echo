import { describe, expect, it } from "vitest";
import { formatDurationFromHours, formatDurationFromSeconds } from "./time";

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
