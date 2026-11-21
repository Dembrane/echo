import { describe, expect, it } from "vitest";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import {
	charsBucket,
	durationBucket,
	fieldsReturned,
	isUseful,
} from "./digest";
import { DIGEST_RESULT_EN } from "./digest.fixture";
import {
	appliedCounts,
	chooseTemplate,
	edit,
	initialReview,
	sectionsShown,
	toCreateBody,
	toggle,
} from "./review";

describe("review state", () => {
	it("starts with every returned part on, and creates with all of it", () => {
		const s = initialReview(DIGEST_RESULT_EN, TEMPLATE_SUMMARIES);
		const body = toCreateBody(s);
		expect(body?.templateKey).toBe("resident_evening");
		expect(body?.name).toBe("Resident evening Kanaalzone-Oost");
		expect(Object.keys(body?.digest ?? {}).sort()).toEqual([
			"context",
			"explore_prompt",
			"goal",
			"host_script_additions",
			"key_terms",
			"name_label",
			"tags",
			"verify_topics",
		]);
	});

	it("a part switched off or emptied is not sent; edits are", () => {
		let s = initialReview(DIGEST_RESULT_EN, TEMPLATE_SUMMARIES);
		s = toggle(s, "explore", false);
		s = edit(s, "goal", "  Learn what works.  ");
		s = edit(s, "tags", ["", " "]);
		const body = toCreateBody(s);
		expect(body?.digest.explore_prompt).toBeUndefined();
		expect(body?.digest.tags).toBeUndefined();
		expect(body?.digest.goal).toBe("Learn what works.");
		expect(
			appliedCounts(s, sectionsShown(DIGEST_RESULT_EN), "resident_evening"),
		).toEqual({
			fields_accepted: 7,
			fields_dropped: 1,
			fields_edited: 2,
			template_changed: false,
		});
	});

	it("no name or no template, no create", () => {
		const s = initialReview(DIGEST_RESULT_EN, TEMPLATE_SUMMARIES);
		expect(toCreateBody({ ...s, name: " " })).toBeNull();
		expect(toCreateBody({ ...s, template: null })).toBeNull();
	});

	it("another template brings its own Verify topics unless the host chose them", () => {
		const s = initialReview(
			{ ...DIGEST_RESULT_EN, verify_topics: undefined },
			TEMPLATE_SUMMARIES,
		);
		const moved = chooseTemplate(
			s,
			"round_table",
			TEMPLATE_SUMMARIES,
			undefined,
		);
		expect(moved.verify.value).toEqual(["agreements", "disagreements"]);
		const chosen = chooseTemplate(
			edit(s, "verify", ["gems"]),
			"round_table",
			TEMPLATE_SUMMARIES,
			undefined,
		);
		expect(chosen.verify.value).toEqual(["gems"]);
	});

	it("useful results, buckets and counts for analytics", () => {
		expect(fieldsReturned(DIGEST_RESULT_EN)).toHaveLength(10);
		expect(isUseful(DIGEST_RESULT_EN)).toBe(true);
		expect(isUseful({ ...DIGEST_RESULT_EN, notes: ["nothing_found"] })).toBe(
			false,
		);
		expect(charsBucket(500)).toBe("<1k");
		expect(charsBucket(60_000)).toBe("50k+");
		expect(durationBucket(12_000)).toBe("5-15s");
	});
});
