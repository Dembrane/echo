import { describe, expect, it } from "vitest";
import { RESIDENT_EVENING_GUIDE } from "@/components/project/templates/hostGuide.fixture";
import { hostGuideText } from "./HostGuidePage";

// ECHO-1053: a template pre-fills project.host_guide with its host script. The page reads
// it as any saved guide, so it shows and stays editable; a language switch falls back.
describe("the host guide a template writes", () => {
	it("is what the page shows, in the project's language", () => {
		const words = hostGuideText({
			host_guide: RESIDENT_EVENING_GUIDE.nl,
			language: "nl",
		});
		expect(words.title).toBe("Een tafel leiden op de bewonersavond");
		expect(words.steps).toHaveLength(6);
		expect(words.steps[3]).toContain("druk op ECHO, dan op Verifiëren");
	});

	it("falls back to the default guide when the project changes language", () => {
		const words = hostGuideText({
			host_guide: RESIDENT_EVENING_GUIDE.nl,
			language: "en",
		});
		expect(words.title).not.toBe("Een tafel leiden op de bewonersavond");
	});

	it("colours only words its steps contain", () => {
		for (const item of [
			...RESIDENT_EVENING_GUIDE.en.steps,
			...RESIDENT_EVENING_GUIDE.en.tips,
		])
			for (const word of item.highlights) expect(item.content).toContain(word);
	});
});
