import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { FreeAllowance } from "@/hooks/useFreeAllowance";
import { ApiRequestError } from "./errors/read";
import {
	allowanceSpent,
	audioUsedUp,
	chatTurnGate,
	formatResetDate,
	freeLimitDetails,
	freeReportsLine,
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
		"map",
		"popcorn",
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

describe("chatTurnGate", () => {
	it("is at the limit once the turns are used", () => {
		expect(chatTurnGate({ frozen: false, limit: 20, used: 20 }).atLimit).toBe(
			true,
		);
		expect(chatTurnGate({ frozen: false, limit: 20, used: 19 }).atLimit).toBe(
			false,
		);
	});

	it("treats a frozen chat as at the limit", () => {
		expect(chatTurnGate({ frozen: true, limit: 20, used: 1 })).toEqual({
			atLimit: true,
			frozen: true,
		});
	});

	it("is open without turn info", () => {
		expect(chatTurnGate(null)).toEqual({ atLimit: false, frozen: false });
		expect(chatTurnGate(undefined)).toEqual({ atLimit: false, frozen: false });
	});
});

describe("allowanceSpent", () => {
	const snap = (over: Partial<FreeAllowance>): FreeAllowance => ({
		audio_seconds: null,
		chats: null,
		free: true,
		maps: null,
		period_start: null,
		popcorn_analyses: null,
		projects: null,
		reports: null,
		resets_at: null,
		...over,
	});

	it("is false when not free or unknown", () => {
		expect(
			allowanceSpent(
				snap({ chats: { limit: 2, used: 2 }, free: false }),
				"chats",
			),
		).toBe(false);
		expect(allowanceSpent(undefined, "chats")).toBe(false);
		expect(allowanceSpent(snap({}), "maps")).toBe(false);
	});

	it("is true once the meter is used up", () => {
		expect(
			allowanceSpent(snap({ chats: { limit: 2, used: 2 } }), "chats"),
		).toBe(true);
		expect(
			allowanceSpent(snap({ chats: { limit: 2, used: 1 } }), "chats"),
		).toBe(false);
		expect(
			allowanceSpent(
				snap({ popcorn_analyses: { limit: 12, used: 12 } }),
				"popcorn_analyses",
			),
		).toBe(true);
	});
});

describe("freeReportsLine", () => {
	beforeAll(() => {
		i18n.load("en", {});
		i18n.activate("en");
	});
	const snap = (limit: number) =>
		({ free: true, reports: { limit, used: 0 } }) as unknown as FreeAllowance;

	it("states the live limit", () => {
		expect(freeReportsLine(snap(1))).toBe(
			"The free plan includes 1 report a month.",
		);
		expect(freeReportsLine(snap(4))).toBe(
			"The free plan includes 4 reports a month.",
		);
	});

	it("states no number when staff set the limit to 0", () => {
		expect(freeReportsLine(snap(0))).toBe(
			"The free plan includes a monthly allowance of reports.",
		);
	});

	it("states no number without a snapshot", () => {
		expect(freeReportsLine(undefined)).toBe(
			"The free plan includes a monthly allowance of reports.",
		);
	});
});

describe("audioUsedUp", () => {
	it("counts under a minute left as used up, as billing does", () => {
		expect(audioUsedUp({ limit: 18000, used: 18000 })).toBe(true);
		expect(audioUsedUp({ limit: 18000, used: 17941 })).toBe(true);
		expect(audioUsedUp({ limit: 18000, used: 17940 })).toBe(false);
		expect(audioUsedUp({ limit: 18000, used: 18300 })).toBe(true);
	});
});

describe("formatResetDate", () => {
	it("formats in the given locale", () => {
		const iso = "2026-11-01T00:00:00Z";
		expect(formatResetDate(iso, "nl-NL")).toBe(
			new Date(iso).toLocaleString("nl-NL", {
				dateStyle: "medium",
				timeStyle: "short",
			}),
		);
	});
	it("is null when missing or unreadable", () => {
		expect(formatResetDate(null, "en")).toBeNull();
		expect(formatResetDate(undefined, "en")).toBeNull();
		expect(formatResetDate("not a date", "en")).toBeNull();
	});
});
