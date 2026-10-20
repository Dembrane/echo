import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./errors/read";
import {
	freeLimitDetails,
	isFreeTierLimitError,
	portalRecordingRefusal,
	recordingStopOf,
} from "./freeTier";

const tierLimit = (limit: string, numbers: Record<string, number> = {}) => ({
	response: {
		data: {
			code: "billing.tier_limit",
			detail: {
				...numbers,
				error: "FREE_TIER_LIMIT",
				limit,
				upgrade_cta_tier: "changemaker",
			},
			params: { limit },
		},
		status: 402,
	},
});

describe("isFreeTierLimitError", () => {
	it.each([
		"projects",
		"organisations",
		"audio_month",
		"audio_conversation",
		"recording_project",
		"chats",
		"workspaces",
	])("reads %s from a coded 402", (limit) => {
		expect(isFreeTierLimitError(tierLimit(limit))).toBe(limit);
	});

	it("reads a new name from the details shape alone", () => {
		expect(
			isFreeTierLimitError({
				detail: { error: "FREE_TIER_LIMIT", limit: "projects" },
			}),
		).toBe("projects");
	});

	it("ignores an unknown name", () => {
		expect(isFreeTierLimitError(tierLimit("bogus"))).toBeNull();
	});
});

describe("freeLimitDetails", () => {
	it("returns the details of a free-limit 402", () => {
		const details = freeLimitDetails(
			new ApiRequestError(402, tierLimit("audio_month").response.data),
		);
		expect(details).toMatchObject({
			error: "FREE_TIER_LIMIT",
			limit: "audio_month",
		});
	});

	it("carries the numbers", () => {
		const details = freeLimitDetails(
			tierLimit("audio_conversation", { remaining_seconds: 30 }),
		);
		expect(details?.remaining_seconds).toBe(30);
	});

	it("is null for anything else", () => {
		expect(
			freeLimitDetails({ response: { data: { detail: "x" }, status: 500 } }),
		).toBeNull();
		expect(freeLimitDetails(new Error("Network Error"))).toBeNull();
	});
});

describe("portalRecordingRefusal", () => {
	it("returns the recording reason of a 402", () => {
		expect(portalRecordingRefusal(tierLimit("audio_month"))).toBe(
			"audio_month",
		);
		expect(portalRecordingRefusal(tierLimit("audio_conversation"))).toBe(
			"audio_conversation",
		);
		expect(portalRecordingRefusal(tierLimit("recording_project"))).toBe(
			"recording_project",
		);
	});

	it("is null for other limits, a 500 and a network error", () => {
		expect(portalRecordingRefusal(tierLimit("projects"))).toBeNull();
		expect(
			portalRecordingRefusal({
				response: { data: { detail: "boom" }, status: 500 },
			}),
		).toBeNull();
		expect(
			portalRecordingRefusal(
				Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }),
			),
		).toBeNull();
	});
});

describe("recordingStopOf", () => {
	it("reads recording_stop", () => {
		expect(recordingStopOf({ recording_stop: "audio_month" })).toBe(
			"audio_month",
		);
		expect(recordingStopOf({ recording_stop: "recording_project" })).toBe(
			"recording_project",
		);
	});

	it("is null when missing or unknown", () => {
		expect(recordingStopOf({})).toBeNull();
		expect(recordingStopOf({ recording_stop: "bogus" })).toBeNull();
		expect(recordingStopOf({ recording_stop: "projects" })).toBeNull();
		expect(recordingStopOf(null)).toBeNull();
		expect(recordingStopOf("audio_month")).toBeNull();
	});
});
