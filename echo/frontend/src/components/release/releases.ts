import { t } from "@lingui/core/macro";
import { getReleaseHistory } from "./releaseHistory";

/**
 * Newest first. The popup shows the first entry; Release notes keeps the full
 * history. Keep each version stable: changing it shows the popup again.
 *
 * To publish an update, prepend a release with a unique version, a short summary
 * and classified changes. Add publication metadata when the tag ships.
 * Video and closing note are optional. Then run
 * messages:extract, translate the catalogs and run messages:compile.
 *
 * Copy resolves on each call so it follows the active locale.
 */
export interface ReleaseChange {
	type: "feature" | "improvement" | "fix";
	text: string;
}

export interface Release {
	/** Stable dismissal key. Keep legacy keys even when adding a GitHub tag. */
	version: string;
	/** Editorial milestone. Independent of the numeric version and release size. */
	highlight?: boolean;
	/** Omitted for an upcoming update. Dates and tags come from GitHub. */
	publication?: {
		tag: string;
		date: string;
		/** Some historical tags have no GitHub Release object. */
		source?: "tag";
	};
	/** Plain text headline shared by the popup and release notes. */
	title: string;
	/** Short Markdown summary for the popup. Falls back to description when omitted. */
	summary?: string;
	/** Optional introduction, or legacy full notes in Markdown. */
	description?: string;
	/** One customer-facing change per bullet, classified independently of semver. */
	changes?: ReleaseChange[];
	/** Optional closing note shown below the full release notes. */
	note?: string;
	/** A YouTube watch, youtu.be, shorts or live link. Converted to a privacy-mode embed. */
	videoUrl?: string;
}

export const getReleases = (): Release[] => [
	{
		changes: [
			{
				text: t`Turn conversations into live slides. Run a live session or an on-demand analysis, present to the room and trace insights to their sources.`,
				type: "feature",
			},
			{
				text: t`Explore stories and perspectives with the Narratives chat template, in English and Dutch.`,
				type: "feature",
			},
			{
				text: t`MCP connections let your agent find projects, search conversations, read transcripts and consult documentation, with organisation controls and explicit consent.`,
				type: "improvement",
			},
			{
				text: t`Custom logo settings now explain the recommended 3:1 aspect ratio.`,
				type: "improvement",
			},
			{
				text: t`Sharing a private project with a non-member now offers an invitation instead of an error, granting access when they join the workspace.`,
				type: "fix",
			},
			{
				text: t`Unreadable audio and invalid transcription responses no longer cause repeated processing attempts.`,
				type: "fix",
			},
			{
				text: t`Deleted projects and conversations paused by plan limits no longer trigger repeated summary attempts.`,
				type: "fix",
			},
			{
				text: t`The sidebar fits mobile screens more reliably, with corrected French navigation labels.`,
				type: "fix",
			},
		],
		highlight: true,
		summary: t`Turn your project's conversations into live slides for the room.

- Follow emerging themes as people talk.
- Present insights and check the conversations behind them.
- Start a live session or run an analysis when you need it.

Plus: new chat templates, agent connections and mobile improvements.`,
		title: t`Introducing Popcorn`,
		version: "2026-09",
	},
	...getReleaseHistory(),
];
