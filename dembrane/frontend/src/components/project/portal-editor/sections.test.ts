import { describe, expect, it } from "vitest";
import { PREVIEW_SCREENS } from "@/lib/portalPreview/protocol";
import { portalDefaults } from "./portalForm";
import {
	EXAMPLE_EXPLORE_MODES,
	EXAMPLE_TOPIC_KEYS,
	exampleResult,
} from "./preview/examples";
import {
	applicableOptions,
	nextSection,
	resolveOption,
	SECTIONS,
} from "./sections";

const values = portalDefaults({ id: "p1", language: "en" } as Project);
const flags = { showAskForEmail: false, showReportNotifications: false };
const keys = (
	section: Parameters<typeof applicableOptions>[0],
	v = values,
	f = flags,
) => applicableOptions(section, v, f).map((o) => o.key);

// ECHO-1060: the pages and options the product owner set, with their conditions.
describe("portal editor sections", () => {
	it("lists each page's options in order", () => {
		expect(keys("welcome")).toEqual([
			"language",
			"title",
			"description",
			"tutorial",
		]);
		expect(keys("privacy")).toEqual(["legal-basis", "anonymise"]);
		expect(keys("finish")).toEqual(["text", "event"]);
	});

	it("shows a conditional option only while it applies", () => {
		expect(keys("about")).toEqual(["ask-name", "tags", "auto-titles"]);
		expect(
			keys(
				"about",
				{
					...values,
					default_conversation_ask_for_participant_name: true,
					enable_ai_title_and_tags: true,
				},
				{ ...flags, showAskForEmail: true },
			),
		).toEqual([
			"ask-name",
			"name-label",
			"tags",
			"auto-titles",
			"title-prompt",
			"ask-email",
		]);
		expect(keys("explore")).toEqual(["enabled"]);
		expect(keys("explore", { ...values, is_get_reply_enabled: true })).toEqual([
			"enabled",
			"mode",
			"other-conversations",
		]);
		expect(
			keys("explore", {
				...values,
				get_reply_mode: "custom",
				is_get_reply_enabled: true,
			}),
		).toEqual(["enabled", "mode", "prompt", "other-conversations"]);
		expect(keys("verify")).toEqual(["enabled"]);
		expect(keys("verify", { ...values, is_verify_enabled: true })).toEqual([
			"enabled",
			"topics",
			"custom-topics",
			"remind",
			"key-terms",
		]);
		expect(
			keys("finish", values, { ...flags, showReportNotifications: true }),
		).toEqual(["text", "notifications", "event"]);
	});

	it("opens the option the address names, or the first that applies", () => {
		expect(resolveOption("welcome", "tutorial", values, flags).key).toBe(
			"tutorial",
		);
		// The custom prompt does not apply in "One question" mode.
		expect(
			resolveOption(
				"explore",
				"prompt",
				{ ...values, is_get_reply_enabled: true },
				flags,
			).key,
		).toBe("enabled");
		expect(resolveOption("about", undefined, values, flags).key).toBe(
			"ask-name",
		);
	});

	it("names a known screen for every option, and the pages in order", () => {
		for (const def of Object.values(SECTIONS)) {
			for (const o of def.options) expect(PREVIEW_SCREENS).toContain(o.screen);
			for (const s of def.screens) expect(PREVIEW_SCREENS).toContain(s);
		}
		expect(nextSection("welcome")).toBe("privacy");
		expect(nextSection("verify")).toBe("finish");
		expect(nextSection("finish")).toBeNull();
	});
});

describe("preview examples", () => {
	it("has one per built-in Verify topic and Explore mode, in every language", () => {
		expect(EXAMPLE_TOPIC_KEYS.sort()).toEqual(
			[
				"actions",
				"agreements",
				"disagreements",
				"gems",
				"heard",
				"moments",
				"truths",
			].sort(),
		);
		expect(EXAMPLE_EXPLORE_MODES.sort()).toEqual(["brainstorm", "summarize"]);
		for (const lang of ["en", "nl", "de", "fr", "es", "it", "uk", "cs"]) {
			for (const key of EXAMPLE_TOPIC_KEYS) {
				const r = exampleResult("verify", key, lang);
				expect(r.source).toBe("example");
				expect(r.text.split("\n").length).toBeGreaterThan(3);
			}
			for (const mode of EXAMPLE_EXPLORE_MODES)
				expect(
					exampleResult("explore", mode, lang).text.length,
				).toBeGreaterThan(10);
		}
		// The Verify drafts open and close as the prompt asks.
		const en = exampleResult("verify", "agreements", "en").text;
		expect(en.startsWith("Draft to correct together.")).toBe(true);
		expect(en.endsWith("Is this right? What is missing or too strong?")).toBe(
			true,
		);
		// A custom topic or mode gets a fitting example, never nothing.
		expect(exampleResult("verify", "our-own", "en").text).toContain(
			"Saturdays",
		);
		expect(exampleResult("explore", "custom", "en").text).toContain("?");
		// No em dashes in the examples.
		for (const lang of ["en", "nl", "de", "fr", "es", "it", "uk", "cs"])
			for (const key of EXAMPLE_TOPIC_KEYS)
				expect(exampleResult("verify", key, lang).text).not.toContain("\u2014");
	});
});
