import { describe, expect, it } from "vitest";
import { recordingClosed, resolvePortalMode } from "./recordingCap";

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

describe("recordingClosed", () => {
	const closed = {
		chunkCount: 0,
		recordingStarted: false,
		takingRecordings: false,
	};
	it("closes an empty conversation on a project not taking recordings", () => {
		expect(recordingClosed(closed)).toBe(true);
	});
	it("keeps the recorder once the conversation has audio", () => {
		expect(recordingClosed({ ...closed, chunkCount: 1 })).toBe(false);
	});
	it("keeps a recording that has started", () => {
		expect(recordingClosed({ ...closed, recordingStarted: true })).toBe(false);
	});
	it("keeps the recorder while the chunks are unknown or the project takes recordings", () => {
		expect(recordingClosed({ ...closed, chunkCount: undefined })).toBe(false);
		expect(recordingClosed({ ...closed, takingRecordings: true })).toBe(false);
		expect(recordingClosed({ ...closed, takingRecordings: undefined })).toBe(
			false,
		);
	});
});
