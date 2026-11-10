import posthog from "posthog-js";

/**
 * The onboarding flow the events describe. Bumped when the flow changes enough that
 * funnels from before and after should not be compared.
 */
export const FLOW_VERSION = 1;

export type OnboardingStep = "org" | "invite" | "questions";
export type ProjectCreateStep = "name" | "key_terms" | "access" | "review";
export type KeyTermsSurface = "wizard" | "portal_editor" | "assistant";
export type PortalShareMethod = "qr" | "copy" | "download";
export type OnboardingWalkthroughStep = string;
/** Why a sign-in failed; components/auth/utils/errorUtils.ts decides it from the answer. */
export type LoginFailureCause =
	| "wrong_credentials"
	| "unverified"
	| "rate_limited"
	| "blocked"
	| "network"
	| "server";

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
	user_login_failed: {
		error_code: string | null;
		cause: LoginFailureCause;
		http_status: number | null;
	};
	login_rate_limit_shown: { retry_after_s: number };
	login_blocked_shown: NoProps;

	// Onboarding.
	onboarding_step_viewed: { step: OnboardingStep };
	onboarding_step_completed: { step: OnboardingStep; skipped?: boolean };

	// Creating a project.
	project_create_started: NoProps;
	project_create_step_viewed: { step: ProjectCreateStep };
	project_create_abandoned: { step: ProjectCreateStep };
	project_created: { project_id: string };

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

	// Reserved for later onboarding tickets. Typed now so the names stay stable; nothing
	// sends them yet.
	project_template_selected: { template_key: string; project_id?: string };
	project_setup_ai_suggested: { project_id: string };
	project_setup_ai_accepted: { project_id: string };
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
