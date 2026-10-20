import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { formatDurationFromHours } from "./time";
import {
	precheckRefusalMessage,
	precheckUploads,
	uploadRefusalMessage,
} from "./uploadPrecheck";

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

const fmt = (seconds: number) => formatDurationFromHours(seconds / 3600);

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

describe("precheckUploads", () => {
	it("refuses a file longer than what is left this month", () => {
		expect(
			precheckUploads([{ name: "a", seconds: 3600 }], {
				fileLimitSeconds: 3600,
				secondsLeft: 1800,
			}),
		).toEqual([
			{
				limitSeconds: 1800,
				name: "a",
				reason: "over_remaining",
				seconds: 3600,
			},
		]);
	});

	it("refuses a file over the per-file limit plus the 1 s tolerance", () => {
		const status = { fileLimitSeconds: 3600, secondsLeft: null };
		expect(precheckUploads([{ name: "a", seconds: 3602 }], status)).toEqual([
			{ limitSeconds: 3600, name: "a", reason: "file_too_long", seconds: 3602 },
		]);
		expect(precheckUploads([{ name: "a", seconds: 3601 }], status)).toEqual([]);
	});

	it("refuses only when the rounded length passes what is left", () => {
		const status = { fileLimitSeconds: null, secondsLeft: 100 };
		expect(precheckUploads([{ name: "a", seconds: 100.4 }], status)).toEqual(
			[],
		);
		expect(
			precheckUploads([{ name: "a", seconds: 100.6 }], status),
		).toHaveLength(1);
	});

	it("never refuses a file of unknown length", () => {
		expect(
			precheckUploads([{ name: "a", seconds: null }], {
				fileLimitSeconds: 1,
				secondsLeft: 0,
			}),
		).toEqual([]);
	});

	it("adds files up in order and refuses the ones that do not fit", () => {
		expect(
			precheckUploads(
				[
					{ name: "a", seconds: 1000 },
					{ name: "b", seconds: 1000 },
					{ name: "c", seconds: 400 },
				],
				{ fileLimitSeconds: 3600, secondsLeft: 1500 },
			),
		).toEqual([
			{ limitSeconds: 500, name: "b", reason: "over_remaining", seconds: 1000 },
		]);
	});

	it("refuses nothing without limits", () => {
		expect(
			precheckUploads([{ name: "a", seconds: 99999 }], {
				fileLimitSeconds: null,
				secondsLeft: null,
			}),
		).toEqual([]);
	});
});

describe("uploadRefusalMessage", () => {
	it("names the file length and the time left for audio_month", () => {
		const text = uploadRefusalMessage(
			tierLimit("audio_month", { file_seconds: 3600, remaining_seconds: 1800 }),
		);
		expect(text).toContain(fmt(3600));
		expect(text).toContain("30 min");
		expect(text).toContain("left this month");
		expect(text).not.toContain("—");
	});

	it("names the file length and the per-file limit for audio_conversation", () => {
		const text = uploadRefusalMessage(
			tierLimit("audio_conversation", {
				file_seconds: 5400,
				limit_seconds: 3600,
			}),
		);
		expect(text).toContain(fmt(5400));
		expect(text).toContain(fmt(3600));
		expect(text).toContain("free plan");
	});

	it("says when nothing is left and no file length is known", () => {
		expect(
			uploadRefusalMessage(tierLimit("audio_month", { remaining_seconds: 0 })),
		).toMatch(/no recording left this month/);
	});

	it("names the recording project refusal", () => {
		expect(uploadRefusalMessage(tierLimit("recording_project"))).toBe(
			"This project is not the one taking recordings on the free plan.",
		);
	});

	it("is null for other errors", () => {
		expect(uploadRefusalMessage(new Error("boom"))).toBeNull();
		expect(uploadRefusalMessage(tierLimit("chats"))).toBeNull();
	});
});

describe("lengths near the limit", () => {
	it("prints seconds when minutes would print the same length twice", () => {
		expect(
			precheckRefusalMessage({
				limitSeconds: 3600,
				name: "a",
				reason: "file_too_long",
				seconds: 3602,
			}),
		).toBe(
			"This file is 1h 0m 2s long. Files can be at most 1h long on the free plan.",
		);
		expect(
			uploadRefusalMessage(
				tierLimit("audio_month", {
					file_seconds: 1801,
					remaining_seconds: 1800,
				}),
			),
		).toBe(
			"This file is 30 min 1 s long. You have 30 min of recording left this month.",
		);
	});
});

describe("precise lengths", () => {
	const tooLong = (seconds: number, limitSeconds: number) =>
		precheckRefusalMessage({
			limitSeconds,
			name: "a",
			reason: "file_too_long",
			seconds,
		});

	it("prints seconds under a minute", () => {
		expect(tooLong(15, 10)).toBe(
			"This file is 15 s long. Files can be at most 10 s long on the free plan.",
		);
	});

	it("prints minutes and seconds under an hour", () => {
		expect(tooLong(225, 120)).toBe(
			"This file is 3 min 45 s long. Files can be at most 2 min long on the free plan.",
		);
	});

	it("prints hours and minutes above an hour", () => {
		expect(tooLong(5430, 3600)).toBe(
			"This file is 1h 30m long. Files can be at most 1h long on the free plan.",
		);
	});
});

describe("precheckRefusalMessage", () => {
	it("reads like the server's refusal", () => {
		expect(
			precheckRefusalMessage({
				limitSeconds: 1800,
				name: "a",
				reason: "over_remaining",
				seconds: 3600,
			}),
		).toBe(
			uploadRefusalMessage(
				tierLimit("audio_month", {
					file_seconds: 3600,
					remaining_seconds: 1800,
				}),
			),
		);
		expect(
			precheckRefusalMessage({
				limitSeconds: 3600,
				name: "a",
				reason: "file_too_long",
				seconds: 5400,
			}),
		).toContain(fmt(3600));
	});
});
