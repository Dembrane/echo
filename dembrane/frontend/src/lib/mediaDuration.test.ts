// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMediaSeconds } from "./mediaDuration";

let created: HTMLMediaElement[] = [];
const revoke = vi.fn();

beforeEach(() => {
	created = [];
	revoke.mockReset();
	URL.createObjectURL = vi.fn(() => "blob:test");
	URL.revokeObjectURL = revoke;
	const real = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(
		(tag: string, opts?: ElementCreationOptions) => {
			const el = real(tag, opts);
			if (tag === "audio" || tag === "video")
				created.push(el as HTMLMediaElement);
			return el;
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const file = (type = "audio/mpeg") => new File(["x"], "a.mp3", { type });

const withDuration = (el: HTMLMediaElement, value: number) =>
	Object.defineProperty(el, "duration", { configurable: true, value });

describe("readMediaSeconds", () => {
	it("resolves a finite duration", async () => {
		const pending = readMediaSeconds(file());
		const el = created[0];
		expect(el.tagName).toBe("AUDIO");
		withDuration(el, 42.5);
		el.dispatchEvent(new Event("loadedmetadata"));
		await expect(pending).resolves.toBe(42.5);
		expect(revoke).toHaveBeenCalledWith("blob:test");
	});

	it("uses a video element for video files", async () => {
		const pending = readMediaSeconds(file("video/mp4"));
		const el = created[0];
		expect(el.tagName).toBe("VIDEO");
		withDuration(el, 10);
		el.dispatchEvent(new Event("loadedmetadata"));
		await expect(pending).resolves.toBe(10);
	});

	it("resolves null for an infinite duration", async () => {
		const pending = readMediaSeconds(file());
		withDuration(created[0], Number.POSITIVE_INFINITY);
		created[0].dispatchEvent(new Event("loadedmetadata"));
		await expect(pending).resolves.toBeNull();
		expect(revoke).toHaveBeenCalledTimes(1);
	});

	it("resolves null on an error", async () => {
		const pending = readMediaSeconds(file());
		created[0].dispatchEvent(new Event("error"));
		await expect(pending).resolves.toBeNull();
		expect(revoke).toHaveBeenCalledTimes(1);
	});

	it("resolves null on the timeout", async () => {
		vi.useFakeTimers();
		const pending = readMediaSeconds(file(), 50);
		vi.advanceTimersByTime(60);
		await expect(pending).resolves.toBeNull();
		expect(revoke).toHaveBeenCalledTimes(1);
	});
});
