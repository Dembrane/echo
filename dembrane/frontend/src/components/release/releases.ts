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
				text: t`Start from a template, like a focus group or citizens' assembly, already set up for you.`,
				type: "feature",
			},
			{
				text: t`Drop in an agenda or invitation and dembrane configures the project for you.`,
				type: "feature",
			},
			{
				text: t`Set up your portal page by page, with a live preview of what participants see.`,
				type: "feature",
			},
			{
				text: t`Test Explore and Verify on a sample conversation before participants use them.`,
				type: "feature",
			},
			{
				text: t`The free plan now includes a monthly AI allowance for chat, reports and more.`,
				type: "feature",
			},
			{
				text: t`Explore can draw on other groups in the project. Turn it off under Cross-pollination.`,
				type: "improvement",
			},
			{
				text: t`When you upgrade, the pricing calculator on dembrane.com helps you pick a plan.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-11-18", tag: "v3.6.0" },
		title: t`Easier onboarding`,
		version: "2026-11",
	},
	{
		changes: [
			{
				text: t`You can now upload Apple Voice Memos (.qta and .m4a files).`,
				type: "fix",
			},
			{
				text: t`Participants are told when their microphone drops, so they can fix it.`,
				type: "fix",
			},
			{ text: t`Chat suggestions no longer get stuck loading.`, type: "fix" },
			{
				text: t`Tags stay where you drop them when you drag them into a new order.`,
				type: "fix",
			},
			{
				text: t`Scrolling to the bottom of a transcript now reaches the very end.`,
				type: "fix",
			},
			{
				text: t`The sign-up form tells you which fields are missing.`,
				type: "fix",
			},
		],
		publication: { date: "2026-10-29", tag: "v3.5.3" },
		title: t`Voice memos and smoother chat`,
		version: "v3.5.3",
	},
	{
		changes: [
			{
				text: t`Uploads no longer fail because of how a file is named.`,
				type: "fix",
			},
		],
		publication: { date: "2026-10-27", tag: "v3.5.2" },
		title: t`More reliable uploads`,
		version: "v3.5.2",
	},
	{
		publication: { date: "2026-10-23", tag: "v3.5.1" },
		title: t`Improvements and bug fixes`,
		version: "v3.5.1",
	},
	{
		changes: [
			{
				text: t`Start using dembrane for free, with recording hours included every month.`,
				type: "feature",
			},
			{
				text: t`A banner tells you when this month's free hours are used up.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-10-23", tag: "v3.5.0" },
		title: t`A new free plan`,
		version: "v3.5.0",
	},
	{
		changes: [
			{
				text: t`The 15-second skip buttons now sit together, so it is easier to replay a moment.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-10-20", tag: "v3.4.1" },
		title: t`Easier playback`,
		version: "v3.4.1",
	},
	{
		changes: [
			{
				text: t`Transcripts are split into paragraphs, so long conversations are easier to read.`,
				type: "improvement",
			},
			{
				text: t`The audio player stays in view while you scroll, so you can listen and read along.`,
				type: "improvement",
			},
			{
				text: t`Long uploads in any audio format are transcribed reliably instead of timing out.`,
				type: "fix",
			},
		],
		publication: { date: "2026-10-20", tag: "v3.4.0" },
		title: t`Easier-to-read transcripts`,
		version: "v3.4.0",
	},
	{
		publication: { date: "2026-10-20", tag: "v3.3.1" },
		title: t`Improvements and bug fixes`,
		version: "v3.3.1",
	},
	{
		changes: [
			{
				text: t`All-new Present features: show live results on a big screen during your session.`,
				type: "feature",
			},
			{
				text: t`Choose what the room sees: Popcorn, Tensions, Map and Stakeholders.`,
				type: "feature",
			},
			{
				text: t`See the arguments from your conversations and the quotes behind them on the Map.`,
				type: "feature",
			},
			{
				text: t`Show popcorn in up to three extra languages at once.`,
				type: "feature",
			},
			{
				text: t`Stay signed in on two devices, such as your phone and laptop.`,
				type: "feature",
			},
			{
				text: t`A cleaner, more accessible dashboard and portal.`,
				type: "improvement",
			},
			{
				text: t`The app feels much faster overall.`,
				type: "improvement",
			},
			{ text: t`Chat is more reliable.`, type: "fix" },
			{ text: t`Uploads show clearly when they fail.`, type: "fix" },
			{
				text: t`Reports publish, schedule and notify as expected.`,
				type: "fix",
			},
		],
		description: t`The [help docs](https://docs.dembrane.com/) are rewritten and up to date.`,
		highlight: true,
		publication: { date: "2026-10-16", tag: "v3.3.0" },
		title: t`dembrane v3`,
		version: "2026-10",
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
