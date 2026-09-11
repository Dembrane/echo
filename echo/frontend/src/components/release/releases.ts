import { t } from "@lingui/core/macro";
import { getReleaseHistory } from "./releaseHistory";

/**
 * Newest first. The popup shows the first entry; Release notes keeps the full
 * history. Keep each version stable: changing it shows the popup again.
 *
 * To publish an update, prepend a release with a unique version and classified
 * changes. Add publication metadata when the tag ships.
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
				text: t`Participants can share the portal from the header or the thank you page: a QR code, a copyable link, WhatsApp, email or the device's own share sheet.`,
				type: "feature",
			},
			{
				text: t`The thank you page invites participants to run their own event with dembrane. Hosts on a paid plan can switch this card off per project in the portal editor.`,
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
				text: t`Release notes live in the app. What's new opens the latest update, and View release notes keeps every past update. Dismissing an update now sticks across your devices.`,
				type: "improvement",
			},
			{
				text: t`The feedback form links straight to Report an issue, so sending a bug with screenshots takes one step fewer.`,
				type: "improvement",
			},
			{
				text: t`The default host guide now reminds hosts to turn on focus mode so notifications stay off the screen while recording.`,
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
		title: t`Introducing Popcorn`,
		version: "2026-09",
		videoUrl: "https://www.youtube.com/watch?v=nKFxtUr13sI",
	},
	...getReleaseHistory(),
];
