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
	/** The monthly AI budget is used up; one wall for every AI action. */
	| "ai_budget"
	| "chat_voice_cap"
	| "custom_logo"
	| "event_cta"
	/** The free allowance card's upgrade button: opens the modal directly, no popover. */
	| "free_allowance"
	| "org_cap"
	| "private_workspace"
	| "project_cap"
	| "recording_project"
	/** A free sample project's own caps (its questions, its one report); not the AI budget. */
	| "sample_cap"
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

/** The AI action a free account was refused when the budget ran out. */
export type AiAction =
	| "chat"
	| "assistant"
	| "voice"
	| "report"
	| "map"
	| "analysis"
	| "popcorn"
	| "canvas"
	| "retranscribe"
	| "summary"
	| "summary_again"
	| "title"
	| "title_again";

/** Walls with fixed prompt copy; aiBudgetHandover and sampleCapHandover write the other two. */
export type PlainWall = Exclude<WallKey, "ai_budget" | "sample_cap">;

/** Which of a sample project's own caps was reached. */
export type SampleCap = "chat" | "report";

/** Fallback when the chat_turns refusal carries no cap; mirrors FREE_TIER_MAX_SAMPLE_USER_TURNS. */
export const SAMPLE_CHAT_QUESTIONS = 10;

/** The opening's phrase for the refused AI action, read as "You were trying to {action}." */
export function aiActionLine(action: AiAction): string {
	const actions: Record<AiAction, string> = {
		analysis: t`run an analysis`,
		assistant: t`ask the assistant`,
		canvas: t`refresh the canvas`,
		chat: t`ask in chat`,
		map: t`generate a map`,
		popcorn: t`keep analysing with popcorn`,
		report: t`create a report`,
		retranscribe: t`retranscribe a conversation`,
		summary: t`generate a summary`,
		summary_again: t`regenerate a summary`,
		title: t`generate a title`,
		title_again: t`regenerate a title`,
		voice: t`use your voice in chat`,
	};
	return actions[action] ?? "";
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
		// Opens the popup directly.
		ai_budget: "",
		billing_page: "",
		chat_voice_cap: "",
		custom_logo: t`Your own logo comes with a paid plan.`,
		event_cta: t`Hiding the dembrane event invitation comes with a paid plan.`,
		free_allowance: "",
		org_cap: t`The free plan includes one organisation.`,
		private_workspace: t`Private workspaces come with a paid plan.`,
		project_cap: t`The free plan includes a limited number of projects.`,
		recording_project: t`On the free plan one project takes recordings.`,
		// Opens the popup directly.
		sample_cap: "",
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
export function wallHandoverTitle(wall: PlainWall): string {
	const titles: Record<PlainWall, string> = {
		billing_page: t`Let's find what fits you`,
		chat_voice_cap: t`You've reached the limit for speaking in chat`,
		custom_logo: t`Your own logo comes with a paid plan`,
		event_cta: t`Hiding the dembrane event invitation comes with a paid plan`,
		free_allowance: t`You've used part of this month's free allowance`,
		org_cap: t`The free plan includes one organisation`,
		private_workspace: t`Private workspaces come with a paid plan`,
		project_cap: t`You've reached the free plan's project limit`,
		recording_project: t`On the free plan, one project takes recordings`,
		transcription_cap: t`You've used this month's free transcription`,
		transcripts_view: t`Transcripts come with a paid plan`,
		upload_cap: t`Uploading recordings comes with a paid plan`,
		webhooks: t`Webhooks come with a paid plan`,
		workspace_cap: t`The free plan covers one workspace`,
	};
	return titles[wall] ?? titles.billing_page;
}

/**
 * The sentence that opens the upgrade prompt's body: going further needs a
 * paid plan. Only the walls whose title names what was used up carry it. A
 * paid feature's title already says it comes with a paid plan, so saying it
 * again would repeat, and the billing page blocks nothing.
 */
export function wallHandoverLead(wall: PlainWall): string {
	const keepGoing = t`A paid plan lets you keep going.`;
	const leads: Record<PlainWall, string> = {
		billing_page: "",
		chat_voice_cap: keepGoing,
		custom_logo: "",
		event_cta: "",
		free_allowance: keepGoing,
		org_cap: keepGoing,
		private_workspace: "",
		project_cap: keepGoing,
		recording_project: keepGoing,
		transcription_cap: keepGoing,
		transcripts_view: "",
		upload_cap: "",
		webhooks: "",
		workspace_cap: keepGoing,
	};
	return leads[wall] ?? "";
}

/**
 * The AI budget wall's title and lead. Used up, it names the refused action
 * (the allowance card refuses none, so it names the allowance) and the reset
 * day. Not used up yet (the 80% banner), it only offers more AI.
 */
export function aiBudgetHandover({
	action: refused,
	resetDay,
	usedUp,
}: {
	action?: AiAction;
	resetDay: string | null;
	usedUp: boolean;
}): { title: string; lead: string } {
	const allowance = t`You're on the free plan, which includes a monthly AI allowance.`;
	if (!usedUp) {
		return {
			lead: t`A paid plan gives you more AI every month.`,
			title: t`Your free plan includes a monthly AI allowance`,
		};
	}
	const action = refused ? aiActionLine(refused) : "";
	const opening = action ? t`You were trying to ${action}.` : allowance;
	const paused = resetDay
		? t`AI features and new recordings are paused until ${resetDay}.`
		: t`AI features and new recordings are paused until next month.`;
	return {
		lead: `${opening} ${paused} ${t`A paid plan lets you keep going.`}`,
		title: t`This month's AI is used up`,
	};
}

/** The sample project wall's title and lead: the cap reached, and the way on. */
export function sampleCapHandover(
	cap: SampleCap | undefined,
	questions: number | null | undefined,
): { title: string; lead: string } {
	const count = questions ?? SAMPLE_CHAT_QUESTIONS;
	return {
		lead: t`Create your own project to keep going.`,
		title:
			cap === "report"
				? t`Sample projects allow one report`
				: t`Sample projects allow ${count} questions`,
	};
}
