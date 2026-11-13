import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture } }));

import {
	type AnalyticsEventName,
	changedFields,
	FLOW_VERSION,
	keyTermCount,
	track,
} from "./events";

describe("track", () => {
	beforeEach(() => capture.mockClear());

	it("sends the event with its properties and the flow version", () => {
		track("project_created", { project_id: "p1", template_key: "event" });
		expect(capture).toHaveBeenCalledWith("project_created", {
			flow_version: FLOW_VERSION,
			project_id: "p1",
			template_key: "event",
		});
	});

	it("sends events without properties", () => {
		track("project_create_started");
		expect(capture).toHaveBeenCalledWith("project_create_started", {
			flow_version: 4,
		});
	});

	it("tells the calm create flow (4) apart from the earlier flows", () => {
		expect(FLOW_VERSION).toBe(4);
		track("project_template_selected", {
			featured: true,
			filters_active: ["verb:understand"],
			setup: "many_groups",
			surface: "create",
			template_key: "resident_evening",
			verbs: ["understand", "decide"],
		});
		expect(capture).toHaveBeenCalledWith("project_template_selected", {
			featured: true,
			filters_active: ["verb:understand"],
			flow_version: 4,
			setup: "many_groups",
			surface: "create",
			template_key: "resident_evening",
			verbs: ["understand", "decide"],
		});
		track("project_template_filter_changed", {
			filter: "verb",
			value: "decide",
		});
		expect(capture).toHaveBeenCalledWith("project_template_filter_changed", {
			filter: "verb",
			flow_version: 4,
			value: "decide",
		});
	});

	it("keeps the names existing dashboards read", () => {
		const kept: AnalyticsEventName[] = [
			"registration_details_completed",
			"user_registered",
			"user_logged_in",
			"user_login_failed",
			"project_create_started",
			"project_created",
			"chat_started",
			"chat_message_sent",
			"conversation_summary_regenerated",
		];
		for (const name of kept) expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
	});

	it("rejects unknown events and wrong properties at compile time", () => {
		// @ts-expect-error not an event in the map
		track("project_made", { project_id: "p1" });
		// @ts-expect-error surface is one of three
		track("key_terms_updated", { count: 1, project_id: "p", surface: "x" });
		// @ts-expect-error step is required
		track("onboarding_step_viewed", {});
		expect(capture).toHaveBeenCalledTimes(3);
	});
});

describe("keyTermCount", () => {
	it("counts distinct, non-empty terms", () => {
		expect(keyTermCount("Eindhoven, dembrane , ,Eindhoven")).toBe(2);
	});

	it("is zero for nothing", () => {
		expect(keyTermCount("")).toBe(0);
		expect(keyTermCount(null)).toBe(0);
		expect(keyTermCount(undefined)).toBe(0);
	});
});

describe("changedFields", () => {
	it("names only the fields whose values changed, sorted", () => {
		expect(
			changedFields(
				{ context: "a", language: "en", name: "x", topics: ["a"] },
				{ context: "b", language: "en", name: "y", topics: ["a"] },
			),
		).toEqual(["context", "name"]);
	});

	it("compares lists and objects by value", () => {
		expect(changedFields({ topics: ["a", "b"] }, { topics: ["a"] })).toEqual([
			"topics",
		]);
		expect(changedFields({ topics: ["a"] }, { topics: ["a"] })).toEqual([]);
	});

	it("treats empty and unset as the same", () => {
		expect(changedFields({ title: null }, { title: "" })).toEqual([]);
		expect(changedFields(undefined, { title: "" })).toEqual([]);
	});

	it("never returns values", () => {
		const out = changedFields({ secret: "old" }, { secret: "new value" });
		expect(out).toEqual(["secret"]);
		expect(JSON.stringify(out)).not.toContain("new value");
	});
});
