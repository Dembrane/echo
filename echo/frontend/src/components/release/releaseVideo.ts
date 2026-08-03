import { RELEASES, type Release } from "./releases";

/**
 * Flat key under `app_user.settings` holding the last release the user
 * dismissed.
 *
 * It has to stay FLAT and top level. `PATCH /v2/me` merges settings one level
 * deep server-side (`{**existing, **incoming}` in api/v2/me.py), so a top-level
 * key is merged alongside its siblings and nothing else is touched. A nested
 * object under a shared parent would be replaced wholesale by the next writer
 * and would silently drop whatever else lived under that parent.
 */
export const RELEASE_VIDEO_SEEN_KEY = "release_video_seen";

/** The release the modal shows, or undefined if the history is empty. */
export const latestRelease = (
	releases: Release[] = RELEASES,
): Release | undefined => releases[0];

/**
 * The seen/unseen gate.
 *
 * Plain string inequality against the newest entry's `version`, deliberately
 * not semver: `version` is an opaque label chosen by whoever adds the release,
 * and the app has no version constant to compare against.
 *
 * Anything that is not exactly the latest version counts as unseen, including
 * null, undefined, an older version, and a non-string value left behind by some
 * other writer. Erring towards showing it is the recoverable direction: the
 * user closes it and the correct value is written.
 */
export const shouldShowReleaseVideo = (
	seen: unknown,
	latestVersion: string | undefined,
): boolean => {
	if (!latestVersion) return false;
	return seen !== latestVersion;
};

/**
 * Convert a YouTube link into a privacy-mode embed URL.
 *
 * The embed host is www.youtube-nocookie.com, which is the only YouTube origin
 * added to `frame-src` in vercel.json. Returning null for anything unrecognised
 * means a malformed link in the releases array degrades to a modal with no
 * video rather than a broken frame or an unexpected origin.
 */
export const youtubeEmbedUrl = (videoUrl: string): string | null => {
	const id = youtubeVideoId(videoUrl);
	return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
};

const YOUTUBE_HOSTS = new Set([
	"m.youtube.com",
	"www.youtube-nocookie.com",
	"www.youtube.com",
	"youtu.be",
	"youtube-nocookie.com",
	"youtube.com",
]);

/** YouTube ids are 11 chars today; the range is loose so an id change does not break playback. */
const VIDEO_ID = /^[\w-]{6,20}$/;

const youtubeVideoId = (videoUrl: string): string | null => {
	let url: URL;
	try {
		url = new URL(videoUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !YOUTUBE_HOSTS.has(url.hostname))
		return null;

	const segments = url.pathname.split("/").filter(Boolean);

	// youtu.be/<id>
	if (url.hostname === "youtu.be") return validId(segments[0]);

	// youtube.com/watch?v=<id>
	if (segments[0] === "watch") return validId(url.searchParams.get("v"));

	// youtube.com/{embed,shorts,live,v}/<id>
	if (
		segments.length === 2 &&
		["embed", "live", "shorts", "v"].includes(segments[0])
	) {
		return validId(segments[1]);
	}

	return null;
};

const validId = (candidate: string | null | undefined): string | null =>
	candidate && VIDEO_ID.test(candidate) ? candidate : null;
