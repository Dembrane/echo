/**
 * The release history. This array is the source of truth: there is no Directus
 * table, no CMS and no app version constant to compare against (package.json is
 * still 0.0.0, and the v3.0.2 shown in the UI belongs to the agentation
 * dependency). Whatever `version` says here IS the version, and the modal gate
 * compares it to the stored value with plain string inequality, never semver.
 *
 * Newest first. The modal renders RELEASES[0] and nothing else; earlier entries
 * are reachable from the changelog page on docs.dembrane.com, linked out of the
 * modal. They stay here because this is what a future release edits, and
 * because the top entry's `version` is the key written to app_user.settings.
 *
 * To ship a release: add a new object at the TOP of this array. Everyone whose
 * stored `release_video_seen` is not the new `version` sees the modal once.
 *
 * `title` and `description` are content, not UI strings, and are deliberately
 * NOT wrapped in <Trans>. They are authored per release in English and would
 * otherwise churn all eight lingui catalogs on every ship, and block a release
 * behind seven translations. The modal's own chrome (labels, the link text) is
 * translated normally.
 */
export interface Release {
	/** Opaque identifier. Compared as a plain string, so any stable value works. */
	version: string;
	/** Plain text. Rendered at the larger of the modal's two type sizes. */
	title: string;
	/**
	 * Markdown. Emphasis is deliberately flattened by the modal's stylesheet:
	 * `**bold**` and `_italic_` render at the same weight and style as the rest
	 * of the body, because the modal is held to two type combinations and no
	 * italics. Structure (paragraphs, lists, links) renders normally.
	 */
	description: string;
	/** A YouTube watch, youtu.be, shorts or live link. Converted to a privacy-mode embed. */
	videoUrl: string;
}

export const RELEASES: Release[] = [
	// Leave `version` alone unless you want everyone who has already dismissed
	// this modal to see it again.
	{
		description: [
			"A short walkthrough of what changed in dembrane this month.",
			"",
			"- Faster transcripts, and clearer status while they run",
			"- A calmer library, with analysis where you expect it",
			"- Small fixes across projects, reports and the portal",
			"",
			"Close this to go straight to your projects.",
		].join("\n"),
		title: "what's new in dembrane",
		version: "2026-08",
		videoUrl: "https://www.youtube.com/watch?v=XSFAF3uSvMg",
	},
];
