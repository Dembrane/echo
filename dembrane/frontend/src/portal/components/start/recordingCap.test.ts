import { describe, expect, it } from "vitest";
import { resolvePortalMode } from "./recordingCap";

describe("resolvePortalMode", () => {
	it("reads mode=text", () => {
		expect(resolvePortalMode(new URLSearchParams("mode=text"))).toBe("text");
	});
	it("treats feedback flags as text", () => {
		expect(resolvePortalMode(new URLSearchParams("general_feedback=1"))).toBe(
			"text",
		);
		expect(resolvePortalMode(new URLSearchParams("feedback=1"))).toBe("text");
	});
	it("defaults to audio", () => {
		expect(resolvePortalMode(new URLSearchParams(""))).toBe("audio");
	});
});
