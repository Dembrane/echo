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
				text: t`Map (Beta) reads a project's transcripts, finds the arguments people make and places related arguments close together.`,
				type: "feature",
			},
			{
				text: t`Present (Beta) is now in every project. Changes show on the room screen as you make them, and wait while someone is watching.`,
				type: "feature",
			},
			{
				text: t`Start a Popcorn analysis with Analyse, or book it with Ready by: it starts 15 minutes before the time you choose.`,
				type: "feature",
			},
			{
				text: t`Choose a light or dark theme, or follow your device, in your settings or the user menu.`,
				type: "feature",
			},
			{
				text: t`Sign in with a code sent to your email instead of a password.`,
				type: "feature",
			},
			{
				text: t`Agentic chat answers at once with a plan and ticks it off as it works. You can close the page and get a notification when it is done.`,
				type: "improvement",
			},
			{
				text: t`Key terms are a step in project creation, and a project can be renamed from its overview or from the menu on its row.`,
				type: "improvement",
			},
			{
				text: t`The collapsed sidebar is now a rail of icons, with each name on hover or on press and hold.`,
				type: "improvement",
			},
			{
				text: t`A refreshed design across the dashboard and the portal, with text and control colours checked for WCAG AA contrast in light and dark.`,
				type: "improvement",
			},
			{
				text: t`People outside your organisation accept an invitation before they join, and workspace admins see their workspace's pending invites.`,
				type: "improvement",
			},
			{
				text: t`An account is signed in on one device at a time. Signing in on another asks first, then logs the other one out.`,
				type: "improvement",
			},
			{
				text: t`Participants who open the portal inside LinkedIn, Instagram or Facebook are asked to open it in their browser, because the microphone may not work there.`,
				type: "improvement",
			},
			{
				text: t`Cloning a project keeps all its settings and custom verify topics.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2026-10-11", tag: "v3.0.0" },
		title: t`dembrane 3`,
		version: "v3.0.0",
	},
	{
		changes: [
			{
				text: t`Turn conversations into live slides. Run a live session or an on-demand analysis, present to the room and trace insights to their sources.`,
				type: "feature",
			},
			{
				text: t`MCP connections let your agent find projects, search conversations, read transcripts and consult documentation, with organisation controls and explicit consent.`,
				type: "feature",
			},
			{
				text: t`Participants can share the portal from the header or the thank you page: a QR code, a copyable link, WhatsApp, email or the device's own share sheet.`,
				type: "feature",
			},
			{
				text: t`Explore stories and perspectives with the Narratives chat template, in English and Dutch.`,
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
				text: t`The sidebar fits mobile screens more reliably, with corrected French navigation labels.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2026-09-11", tag: "v2.4.0" },
		title: t`Introducing Popcorn`,
		version: "2026-09",
		videoUrl: "https://www.youtube.com/watch?v=nKFxtUr13sI",
	},
	...getReleaseHistory(),
];
