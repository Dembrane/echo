import posthog from "posthog-js";

/**
 * The onboarding flow the events describe. Bumped when the flow changes enough that
 * funnels from before and after should not be compared.
 *
 * 1: signup to the organisation overview, then a four-step project wizard (name, key
 *    terms, access, review).
 * 2 (ECHO-1042): a self-serve host goes from signup to the template picker; the wizard is
 *    template, then name, with key terms, access and review behind "More options".
 * 3 (ECHO-1053): templates by purpose. The picker shows the most used cards first, with
 *    filters for the rest and "Upload recordings" and "Start blank" as links; the name step
 *    says what the template sets up. The steps are flow 2's.
 */
export const FLOW_VERSION = 3;

export type OnboardingStep = "org" | "invite" | "questions";
/** Flow 2's and 3's steps; flow 1 also sent "key_terms", "access" and "review". */
export type ProjectCreateStep = "template" | "name" | "more_options";
export type TemplateSurface = "create" | "workspace_home";
/** A picker filter (ECHO-1053): a verb, the setup, or "Show all". */
export type TemplateFilterName = "verb" | "setup" | "show_all";
export type KeyTermsSurface = "wizard" | "portal_editor" | "assistant";
export type SetupSuggestionSurface = "wizard" | "portal_editor";
/** Where the digest's drop zone sits: the template picker or the name step. */
export type DigestSurface = "picker" | "name_step";
export type ProjectStartedFrom = "digest" | "picker";
export type PortalShareMethod = "qr" | "copy" | "download";
export type OnboardingWalkthroughStep = string;

type NoProps = Record<never, never>;

/**
 * Every event sent through `track`, with the properties it carries. Names are snake_case
 * object_action in the past tense. Properties never hold names, emails, transcript text
 * or key term values: the person's email is a person property, set on identify.
 */
export interface AnalyticsEvents {
	// Registration and sign-in.
	registration_details_completed: { from_invite: boolean };
	user_registered: { from_invite: boolean };
	user_logged_in: NoProps;
	user_login_failed: { error_code: string | null };

	// Onboarding.
	onboarding_step_viewed: { step: OnboardingStep };
	onboarding_step_completed: { step: OnboardingStep; skipped?: boolean };

	// Creating a project.
	project_create_started: NoProps;
	project_create_step_viewed: { step: ProjectCreateStep };
	project_create_abandoned: { step: ProjectCreateStep };
	// ECHO-1055: "digest" when the host created from the review of their material.
	project_created: {
		project_id: string;
		template_key: string;
		started_from?: ProjectStartedFrom;
	};
	// A host committed to a template: continued with a card, started blank or uploading, or
	// picked one on workspace home. Not sent for each card the arrow keys pass over. Flow 3
	// adds the card's verbs and setup, whether it was in the first view, and the filters on
	// ("verb:<verb>", "setup:<setup>", "show_all"): keys only, never free text.
	project_template_selected: {
		template_key: string;
		surface: TemplateSurface;
		verbs: string[];
		setup: string | null;
		featured: boolean;
		filters_active: string[];
	};
	// A picker filter changed: its new value is a verb, a setup, "none", "on" or "off".
	project_template_filter_changed: {
		filter: TemplateFilterName;
		value: string;
		surface?: TemplateSurface;
	};

	// Setting up a project.
	key_terms_updated: {
		project_id: string;
		count: number;
		surface: KeyTermsSurface;
	};
	portal_link_shared: { project_id: string; method: PortalShareMethod };
	project_settings_saved: { project_id: string; fields_changed: string[] };
	portal_settings_saved: { project_id: string; fields_changed: string[] };

	// Reading conversations.
	transcript_viewed: { project_id: string; conversation_id: string };
	summary_viewed: { project_id: string; conversation_id: string };
	conversation_summary_regenerated: {
		project_id?: string;
		conversation_id?: string;
	};

	// Chat.
	chat_started: { chat_id: string; mode: string; project_id: string };
	chat_message_sent: {
		chat_id: string;
		template_key: string | null;
		project_id?: string;
	};
	chat_error: { chat_id: string; message?: string; project_id?: string };
	chat_rate_limited: { chat_id: string; message?: string; project_id?: string };
	agentic_chat_intro_opened: { source: string; project_id?: string };
	agentic_chat_intro_confirmed: { source: string; project_id?: string };

	// Setup suggestions (ECHO-1043): counts and flags only, never the host's text, the
	// link or the terms. "accepted" is sent once at create in the wizard (what the host
	// kept), and on each accept in the portal editor.
	project_setup_ai_suggested: {
		template_key: string;
		has_text: boolean;
		has_url: boolean;
		terms_proposed: number;
		settings_proposed: number;
		surface: SetupSuggestionSurface;
	};
	project_setup_ai_accepted: {
		terms_accepted: number;
		settings_accepted: number;
		surface: SetupSuggestionSurface;
	};
	project_setup_ai_failed: { cause: string; surface: SetupSuggestionSurface };

	// The context digest (ECHO-1055): a host drops their material and dembrane proposes the
	// setup. Counts, kinds and buckets only: never file names, text, terms or snippets.
	project_digest_started: {
		sources: number;
		kinds: string[];
		total_chars_bucket: string;
		surface: DigestSurface;
	};
	project_digest_ready: {
		fields_returned: number;
		template_key: string | null;
		duration_ms_bucket: string;
		surface: DigestSurface;
	};
	project_digest_failed: { cause: string; surface: DigestSurface };
	project_digest_applied: {
		fields_accepted: number;
		fields_edited: number;
		fields_dropped: number;
		template_changed: boolean;
	};

	// Reserved for later onboarding tickets. Typed now so the names stay stable; nothing
	// sends them yet.
	onboarding_walkthrough_started: NoProps;
	onboarding_walkthrough_step: { step: OnboardingWalkthroughStep };
	onboarding_walkthrough_completed: NoProps;
	onboarding_walkthrough_dismissed: { step?: OnboardingWalkthroughStep };
	onboarding_checklist_item_completed: { item: string };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

type PropsArg<E extends AnalyticsEventName> = NoProps extends AnalyticsEvents[E]
	? [props?: AnalyticsEvents[E]]
	: [props: AnalyticsEvents[E]];

/**
 * Sends one product analytics event. Every event carries `flow_version`. PostHog itself
 * decides whether anything leaves the browser: local and testing are opted out at init.
 */
export function track<E extends AnalyticsEventName>(
	event: E,
	...[props]: PropsArg<E>
): void {
	posthog.capture(event, { ...(props ?? {}), flow_version: FLOW_VERSION });
}

/** How many terms a key terms value holds (one comma-separated string). */
export function keyTermCount(value: string | null | undefined): number {
	if (!value) return 0;
	return new Set(
		value
			.split(",")
			.map((term) => term.trim())
			.filter(Boolean),
	).size;
}

/**
 * The names of the fields whose values differ between two saves. Only names: the
 * values never leave the browser.
 */
export function changedFields(
	before: Record<string, unknown> | null | undefined,
	after: Record<string, unknown>,
): string[] {
	const prev = before ?? {};
	const keys = new Set([...Object.keys(prev), ...Object.keys(after)]);
	return [...keys].filter((key) => !sameValue(prev[key], after[key])).sort();
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	// A field cleared to "" and one never set mean the same to a host.
	if ((a ?? "") === "" && (b ?? "") === "") return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}
