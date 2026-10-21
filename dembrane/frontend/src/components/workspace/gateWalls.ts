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
	 * carries the configurator too. Managed accounts and accounts with an
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
 * so the modal opens with the cap line above the free plan block instead of
 * naming a feature.
 *
 * A locked data wall has no popover. It opens the modal directly, so
 * `pricing_config_gate_viewed` fires there with `surface="modal"`.
 */
const LOCKED_DATA_WALLS: WallKey[] = ["transcription_cap"];

export function isLockedDataWall(wall: WallKey): boolean {
	return LOCKED_DATA_WALLS.includes(wall);
}

/** The variant the configurator renders for this wall. */
export function variantFor(wall: WallKey): "default" | "transcription_cap" {
	return isLockedDataWall(wall) ? "transcription_cap" : "default";
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
 * What the person was trying to do when they met this wall.
 *
 * It fills the opening line, "You were trying to {action}.", which is the
 * first thing the modal says. The modal still names no feature and no tier:
 * it names the ATTEMPT, which the app already knows, because the wall is
 * keyed. That is the whole of the per-wall variation, and everything under it
 * is byte for byte the same from every mount.
 *
 * A phrase, never a sentence: it is read inside that line, so it starts
 * lowercase and carries no full stop of its own.
 *
 * An empty string means there is no attempt to name, and the opening falls
 * back to "You are on the free plan.":
 *   - `billing_page` because it is not a wall. Nothing is blocked there, so
 *     nobody was stopped from doing anything.
 *   - any mount that names no wall at all, which is the website mount and the
 *     configurator used standalone.
 */
export function wallActionLine(wall: WallKey | string | undefined): string {
	if (!wall) return "";
	const actions: Record<WallKey, string> = {
		billing_page: "",
		chat_cap: t`ask more in chat`,
		chat_turn_cap: t`ask more in chat`,
		chat_voice_cap: t`use your voice in chat`,
		custom_logo: t`add your logo`,
		event_cta: t`hide the dembrane event invitation`,
		free_allowance: t`go beyond this month's free allowance`,
		map_cap: t`generate another map`,
		org_cap: t`create more organisations`,
		popcorn_cap: t`keep analysing with popcorn`,
		private_workspace: t`make a workspace private`,
		project_cap: t`add more projects`,
		recording_project: t`record in every project`,
		report_cap: t`create another report`,
		// The one locked data wall. Nothing was blocked in the room: the
		// recording ran and the participants never met a wall. What stopped is
		// the transcription of what they said.
		transcription_cap: t`have your recordings transcribed`,
		transcripts_view: t`see transcripts`,
		upload_cap: t`upload recordings`,
		webhooks: t`use webhooks`,
		workspace_cap: t`add a workspace`,
	};
	return actions[wall as WallKey] ?? "";
}
