import { expect, it } from "vitest";
import { transcriptRefetchInterval } from "./index";

const done = { error: null, transcript: "hello" };
const failed = { error: "boom", transcript: null };
const pending = { error: null, transcript: "  " };

it("keeps polling while the conversation is recording", () => {
	expect(transcriptRefetchInterval(false, [{ chunks: [done] }], 30000)).toBe(
		30000,
	);
});

it("keeps polling a finished conversation while a part is transcribing", () => {
	expect(
		transcriptRefetchInterval(
			true,
			[{ chunks: [done] }, { chunks: [done, pending] }],
			30000,
		),
	).toBe(30000);
});

it("stops once every part of a finished conversation has text or an error", () => {
	expect(
		transcriptRefetchInterval(
			true,
			[{ chunks: [done, failed] }, { chunks: [done] }],
			30000,
		),
	).toBe(false);
});

it("stops for a finished conversation with nothing loaded", () => {
	expect(transcriptRefetchInterval(true, undefined, 30000)).toBe(false);
});

it("never polls when polling is off", () => {
	expect(transcriptRefetchInterval(false, undefined, false)).toBe(false);
});
