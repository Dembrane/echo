import { describe, expect, it } from "vitest";
import { RELEASES } from "./releases";
import {
	latestRelease,
	RELEASE_VIDEO_SEEN_KEY,
	shouldShowReleaseVideo,
	youtubeEmbedUrl,
} from "./releaseVideo";

// The gate decides whether a full-screen modal lands on someone mid-work, so
// every branch of it is pinned here.
describe("shouldShowReleaseVideo", () => {
	it("shows when nothing has been stored yet", () => {
		expect(shouldShowReleaseVideo(undefined, "2026-08")).toBe(true);
		expect(shouldShowReleaseVideo(null, "2026-08")).toBe(true);
	});

	it("shows when an older release was the last one seen", () => {
		expect(shouldShowReleaseVideo("2026-07", "2026-08")).toBe(true);
	});

	it("hides once the newest release has been dismissed", () => {
		expect(shouldShowReleaseVideo("2026-08", "2026-08")).toBe(false);
	});

	it("compares as plain strings, never as versions", () => {
		// "2026-10" sorts above "2026-9" lexically and below it numerically.
		// Neither matters: anything that is not an exact match is unseen.
		expect(shouldShowReleaseVideo("2026-10", "2026-9")).toBe(true);
		expect(shouldShowReleaseVideo("v2", "v10")).toBe(true);
	});

	it("treats junk left by another writer as unseen rather than trusting it", () => {
		expect(shouldShowReleaseVideo(true, "2026-08")).toBe(true);
		expect(shouldShowReleaseVideo(0, "2026-08")).toBe(true);
		expect(shouldShowReleaseVideo({ version: "2026-08" }, "2026-08")).toBe(
			true,
		);
		expect(shouldShowReleaseVideo("", "2026-08")).toBe(true);
	});

	it("never shows when there is no release to show", () => {
		expect(shouldShowReleaseVideo(undefined, undefined)).toBe(false);
		expect(shouldShowReleaseVideo("2026-08", undefined)).toBe(false);
		expect(shouldShowReleaseVideo(undefined, "")).toBe(false);
	});
});

describe("latestRelease", () => {
	it("takes the first entry, because the array is newest first", () => {
		const releases = [
			{ description: "b", title: "B", version: "2", videoUrl: "" },
			{ description: "a", title: "A", version: "1", videoUrl: "" },
		];
		expect(latestRelease(releases)?.version).toBe("2");
	});

	it("returns undefined for an empty history instead of throwing", () => {
		expect(latestRelease([])).toBeUndefined();
	});
});

describe("the shipped release history", () => {
	it("has a newest entry whose video resolves to a playable embed", () => {
		const release = latestRelease();
		expect(release).toBeDefined();
		expect(youtubeEmbedUrl(release?.videoUrl ?? "")).not.toBeNull();
	});

	it("uses unique version identifiers, so the gate cannot stick", () => {
		const versions = RELEASES.map((r) => r.version);
		expect(new Set(versions).size).toBe(versions.length);
	});

	it("stores under a flat top-level settings key", () => {
		// PATCH /v2/me merges app_user.settings one level deep, so a key
		// containing a path separator would imply nesting that the merge cannot
		// preserve. Sibling keys survive only while this stays flat.
		expect(RELEASE_VIDEO_SEEN_KEY).not.toContain(".");
		expect(RELEASE_VIDEO_SEEN_KEY).toMatch(/^[a-z0-9_]+$/);
	});
});

describe("youtubeEmbedUrl", () => {
	const EMBED = "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?rel=0";

	it("converts every YouTube link shape to the privacy-mode embed", () => {
		expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ")).toBe(
			EMBED,
		);
		expect(youtubeEmbedUrl("https://youtu.be/aqz-KE-bpKQ")).toBe(EMBED);
		expect(youtubeEmbedUrl("https://www.youtube.com/embed/aqz-KE-bpKQ")).toBe(
			EMBED,
		);
		expect(youtubeEmbedUrl("https://www.youtube.com/shorts/aqz-KE-bpKQ")).toBe(
			EMBED,
		);
		expect(youtubeEmbedUrl("https://www.youtube.com/live/aqz-KE-bpKQ")).toBe(
			EMBED,
		);
	});

	it("keeps extra query parameters out of the embed", () => {
		expect(
			youtubeEmbedUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=42s"),
		).toBe(EMBED);
	});

	it("refuses anything that is not an https YouTube link", () => {
		// frame-src only allows www.youtube-nocookie.com, so a link that would
		// have framed some other origin has to degrade to no video at all.
		expect(youtubeEmbedUrl("https://vimeo.com/76979871")).toBeNull();
		expect(
			youtubeEmbedUrl("http://www.youtube.com/watch?v=aqz-KE-bpKQ"),
		).toBeNull();
		expect(
			youtubeEmbedUrl("https://youtube.com.evil.test/watch?v=abc"),
		).toBeNull();
		expect(youtubeEmbedUrl("javascript:alert(1)")).toBeNull();
		expect(youtubeEmbedUrl("not a url")).toBeNull();
		expect(youtubeEmbedUrl("")).toBeNull();
	});

	it("refuses a YouTube link with no usable video id", () => {
		expect(youtubeEmbedUrl("https://www.youtube.com/watch")).toBeNull();
		expect(youtubeEmbedUrl("https://www.youtube.com/")).toBeNull();
		expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=abc")).toBeNull();
	});
});
