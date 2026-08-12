import { t } from "@lingui/core/macro";

/**
 * The release history. This list is the source of truth: there is no Directus
 * table, no CMS and no app version constant to compare against (package.json is
 * still 0.0.0, and the v3.0.2 shown in the UI belongs to the agentation
 * dependency). Whatever `version` says here IS the version, and the modal gate
 * compares it to the stored value with plain string inequality, never semver.
 *
 * Newest first. The modal renders getReleases()[0] and nothing else; earlier
 * entries stay here because this is what a future release edits, and because
 * the top entry's `version` is the key written to app_user.settings.
 *
 * To ship a release: add a new object at the TOP of this list, then run the
 * translation workflow (`pnpm messages:extract`, fill the catalogs,
 * `pnpm messages:compile`). Everyone whose stored `release_video_seen` is not
 * the new `version` sees the modal once.
 *
 * Every line of copy the modal shows lives on the release object: the header
 * line, the title, the description and the closing note. The component holds
 * none of it. All four go through the `t` macro, so they translate like any
 * other UI string. That is also why this is a function rather than a constant:
 * `t` at module scope would evaluate once at import time, before a locale is
 * activated, and freeze the English text. Evaluating per call, at render,
 * returns the active locale's text.
 */
export interface Release {
	/** Opaque identifier. Compared as a plain string, so any stable value works. */
	version: string;
	/** Plain text, in the modal header beside the close button. */
	headerTitle: string;
	/** Plain text. Rendered at the larger of the modal's two type sizes. */
	title: string;
	/**
	 * Markdown. Emphasis is deliberately flattened by the modal's stylesheet:
	 * `**bold**` and `_italic_` render at the same weight and style as the rest
	 * of the body, because the modal is held to two type combinations and no
	 * italics. Structure (paragraphs, lists, links) renders normally.
	 */
	description: string;
	/** Plain text. The last thing in the modal, below the description. */
	note: string;
	/** A YouTube watch, youtu.be, shorts or live link. Converted to a privacy-mode embed. */
	videoUrl: string;
}

export const getReleases = (): Release[] => [
	// Leave `version` alone unless you want everyone who has already dismissed
	// this modal to see it again.
	{
		description: t`This quick walkthrough recaps our new three-level hierarchy: organisations, workspaces, and projects. Watch to learn how to manage access, organise your work, and use our new analysis tools.`,
		headerTitle: t`Message from the dembrane team`,
		note: t`Remember you can always use the Feedback button for suggestions. We appreciate all your support, and thank you for using dembrane.`,
		title: t`Understanding our new structure`,
		version: "2026-08",
		videoUrl: t`https://www.youtube.com/watch?v=XSFAF3uSvMg`,
	},
];
