import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { readAfterFinish } from "./finishedRead";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const loop = (after: { id: string; name: string | null }[] | null) => ({
	status: "paused",
	mode: "manual" as const,
	last_read_after: after,
});

describe("readAfterFinish", () => {
	it("says nothing when a host or the live chain caused the last read", () => {
		expect(readAfterFinish(null)).toBeNull();
		expect(readAfterFinish(loop(null))).toBeNull();
		expect(readAfterFinish(loop([]))).toBeNull();
	});

	it("names one conversation, or counts them", () => {
		expect(readAfterFinish(loop([{ id: "a", name: "Table 4" }]))).toBe(
			"Read after Table 4 finished",
		);
		expect(readAfterFinish(loop([{ id: "a", name: null }]))).toBe(
			"Read after a conversation finished",
		);
		expect(
			readAfterFinish(
				loop([
					{ id: "a", name: "Table 4" },
					{ id: "b", name: "Table 6" },
				]),
			),
		).toBe("Read after 2 conversations finished");
	});
});
