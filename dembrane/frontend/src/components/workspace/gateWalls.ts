import { t } from "@lingui/core/macro";

/**
 * The walls, keyed.
 *
 * `wall_key` is a stable snake_case key that is never translated. It replaces
 * the old `feature_name` display string, which counted one wall twice because
 * it was translated: "Werkruimtelimiet bereikt" and "Workspace limit reached"
 * were the same wall. Every mount names its wall. A mount that cannot name
 * its wall is a bug, not a default.
 *
 * The same keys are used by the analytics events, so counts from before and
 * after the rename join through them.
 */
export type WallKey =
	/**
	 * The one entry that is not a wall.
	 *
	 * The billing page of an account with nothing to pay (free, or comped)
	 * carries the upgrade prompt too. Managed accounts and accounts with an
	 * existing subscription are the two exceptions and keep their own panels.
	 * Nothing is blocked here, so there is no control to hang a popover on and
	 * no tier to require. It opens the modal directly and reports
	 * `surface="modal"`.
	 */
	| "billing_page"
	| "chat_cap"
	| "chat_turn_cap"
	| "chat_voice_cap"
	| "custom_logo"
	| "event_cta"
	/** The free allowance card's upgrade button: opens the modal directly, no popover. */
	| "free_allowance"
	| "map_cap"
	| "org_cap"
	| "popcorn_cap"
	| "private_workspace"
	| "project_cap"
	| "recording_project"
	| "report_cap"
	| "transcription_cap"
	| "transcripts_view"
	| "upload_cap"
	| "webhooks"
	| "workspace_cap";

/**
 * The locked data family.
 *
 * These walls are about data the person already has, not about a feature they
 * do not. The recording kept running and the participants never met a wall,
 * so the prompt says that nothing they recorded is lost instead of
 * naming a feature.
 *
 * A locked data wall has no popover. It opens the modal directly, so
 * `pricing_config_gate_viewed` fires there with `surface="modal"`.
 */
const LOCKED_DATA_WALLS: WallKey[] = ["transcription_cap"];

export function isLockedDataWall(wall: WallKey): boolean {
	return LOCKED_DATA_WALLS.includes(wall);
}

/**
 * The one line the popover carries. One line per wall.
 *
 * The feature is named here and nowhere else. The modal never names it,
 * because the popover named it one click earlier.
 *
 * Every line says "a paid plan". No line names a tier. Staff edit the free
 * limits, so no line states one.
 *
 * An empty string means this wall has no popover line, so the blocked control
 * carries no popover and the modal opens directly:
 *   - `transcription_cap` by design, it is the locked data exception;
 *   - `chat_voice_cap` because the agreed copy holds no line for it. Do not
 *     invent one.
 *   - `billing_page` because it is not a wall. Nothing is blocked on that
 *     page, so there is no control for a popover to sit on.
 */
export function wallPopoverLine(wall: WallKey): string {
	const lines: Record<WallKey, string> = {
		billing_page: "",
		// Both chat walls read the same line: it covers chats and turns.
		chat_cap: t`The free plan includes a few chats a month, each with a set number of questions.`,
		chat_turn_cap: t`The free plan includes a few chats a month, each with a set number of questions.`,
		chat_voice_cap: "",
		custom_logo: t`Your own logo comes with a paid plan.`,
		event_cta: t`Hiding the dembrane event invitation comes with a paid plan.`,
		free_allowance: "",
		map_cap: t`The free plan includes a monthly allowance of maps.`,
		org_cap: t`The free plan includes one organisation.`,
		popcorn_cap: t`The free plan includes a monthly allowance of popcorn analyses.`,
		private_workspace: t`Private workspaces come with a paid plan.`,
		project_cap: t`The free plan includes a limited number of projects.`,
		recording_project: t`On the free plan one project takes recordings.`,
		report_cap: t`The free plan includes a monthly allowance of reports.`,
		transcription_cap: "",
		transcripts_view: t`Transcripts come with a paid plan.`,
		upload_cap: t`Uploading recordings comes with a paid plan.`,
		webhooks: t`Webhooks come with a paid plan.`,
		workspace_cap: t`The free plan covers one workspace.`,
	};
	return lines[wall] ?? "";
}

/**
 * The title of the upgrade prompt: what the person just ran into, in their
 * words, before anything asks them to go anywhere. A monthly allowance says it
 * is used up, a paid feature says what it is, a count says the free plan's
 * number. The billing page blocks nothing, so it opens on the plain offer to
 * find what fits.
 *
 * No line names a tier or a number: staff edit the free limits.
 */
export function wallHandoverTitle(wall: WallKey): string {
	const titles: Record<WallKey, string> = {
		billing_page: t`Let's find what fits you`,
		chat_cap: t`You've used this month's free chats`,
		chat_turn_cap: t`You've used the free questions in this chat`,
		chat_voice_cap: t`You've reached the limit for speaking in chat`,
		custom_logo: t`Your own logo comes with a paid plan`,
		event_cta: t`Hiding the dembrane event invitation comes with a paid plan`,
		free_allowance: t`You've used part of this month's free allowance`,
		map_cap: t`You've used this month's free maps`,
		org_cap: t`The free plan includes one organisation`,
		popcorn_cap: t`You've used this month's free popcorn analyses`,
		private_workspace: t`Private workspaces come with a paid plan`,
		project_cap: t`You've reached the free plan's project limit`,
		recording_project: t`On the free plan, one project takes recordings`,
		report_cap: t`You've used this month's free reports`,
		transcription_cap: t`You've used this month's free transcription`,
		transcripts_view: t`Transcripts come with a paid plan`,
		upload_cap: t`Uploading recordings comes with a paid plan`,
		webhooks: t`Webhooks come with a paid plan`,
		workspace_cap: t`The free plan covers one workspace`,
	};
	return titles[wall] ?? titles.billing_page;
}
