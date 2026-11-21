import { z } from "zod";
import { TUTORIAL_SLUGS } from "@/lib/portalPreview/protocol";
import {
	PROJECT_LANGUAGE_CODES,
	type ProjectLanguageCode,
	projectLanguageForForm,
} from "../projectLanguage";
import type { SectionKey } from "./sectionKeys";

/** The longest name box label the API takes (platform project-templates NAME_LABEL_MAX). */
export const NAME_LABEL_MAX = 80;

/**
 * Every value the portal editor saves on the project, as the one-page editor had them
 * (ECHO-1060 splits the page, not the values): same fields, same validation.
 */
export const PortalFormSchema = z.object({
	anonymize_transcripts: z.boolean(),
	// The name box's label (ECHO-1053); empty means the portal's own "Session name".
	conversation_ask_for_participant_name_label: z.string().max(NAME_LABEL_MAX),
	conversation_title_prompt: z.string(),
	default_conversation_ask_for_participant_email: z.boolean(),
	default_conversation_ask_for_participant_name: z.boolean(),
	default_conversation_description: z.string(),
	default_conversation_finish_text: z.string(),
	default_conversation_title: z.string(),
	default_conversation_tutorial_slug: z.string(),
	enable_ai_title_and_tags: z.boolean(),
	get_reply_mode: z.string(),
	get_reply_prompt: z.string(),
	is_dembrane_event_cta_enabled: z.boolean(),
	is_get_reply_cross_pollination_enabled: z.boolean(),
	is_get_reply_enabled: z.boolean(),
	is_project_notification_subscription_allowed: z.boolean(),
	is_verify_enabled: z.boolean(),
	is_verify_on_finish_enabled: z.boolean(),
	language: z.enum(
		PROJECT_LANGUAGE_CODES as [ProjectLanguageCode, ...ProjectLanguageCode[]],
	),
	verification_topics: z.array(z.string()),
});

export type PortalFormValues = z.infer<typeof PortalFormSchema>;
export type PortalField = keyof PortalFormValues;

export { isSectionKey, SECTION_KEYS, type SectionKey } from "./sectionKeys";

/** The values each page saves. Legal basis and tags save themselves, as before. */
export const SECTION_FIELDS: Record<SectionKey, readonly PortalField[]> = {
	about: [
		"default_conversation_ask_for_participant_name",
		"conversation_ask_for_participant_name_label",
		"enable_ai_title_and_tags",
		"conversation_title_prompt",
		"default_conversation_ask_for_participant_email",
	],
	explore: [
		"is_get_reply_enabled",
		"get_reply_mode",
		"get_reply_prompt",
		"is_get_reply_cross_pollination_enabled",
	],
	finish: [
		"default_conversation_finish_text",
		"is_project_notification_subscription_allowed",
		"is_dembrane_event_cta_enabled",
	],
	privacy: ["anonymize_transcripts"],
	verify: [
		"is_verify_enabled",
		"verification_topics",
		"is_verify_on_finish_enabled",
	],
	welcome: [
		"language",
		"default_conversation_title",
		"default_conversation_description",
		"default_conversation_tutorial_slug",
	],
};

export const normalizeTopicList = (topics: string[]): string[] =>
	Array.from(
		new Set(topics.map((topic) => topic.trim()).filter(Boolean)),
	).sort();

/** The form's values for a project, as the one-page editor read them. */
export function portalDefaults(
	project: Project,
	selectedTopics: string[] = [],
): PortalFormValues {
	const rawTutorialSlug =
		project.default_conversation_tutorial_slug?.toLowerCase() ?? "";
	return {
		anonymize_transcripts: project.anonymize_transcripts ?? false,
		conversation_ask_for_participant_name_label:
			project.conversation_ask_for_participant_name_label ?? "",
		conversation_title_prompt: project.conversation_title_prompt ?? "",
		default_conversation_ask_for_participant_email:
			project.default_conversation_ask_for_participant_email ?? false,
		default_conversation_ask_for_participant_name:
			project.default_conversation_ask_for_participant_name ?? false,
		default_conversation_description:
			project.default_conversation_description ?? "",
		default_conversation_finish_text:
			project.default_conversation_finish_text ?? "",
		default_conversation_title: project.default_conversation_title ?? "",
		default_conversation_tutorial_slug: (
			TUTORIAL_SLUGS as readonly string[]
		).includes(rawTutorialSlug)
			? rawTutorialSlug
			: "none",
		enable_ai_title_and_tags: project.enable_ai_title_and_tags ?? false,
		get_reply_mode: project.get_reply_mode ?? "summarize",
		get_reply_prompt: project.get_reply_prompt ?? "",
		is_dembrane_event_cta_enabled:
			project.is_dembrane_event_cta_enabled ?? true,
		is_get_reply_cross_pollination_enabled:
			project.is_get_reply_cross_pollination_enabled ?? true,
		is_get_reply_enabled: project.is_get_reply_enabled ?? false,
		is_project_notification_subscription_allowed:
			project.is_project_notification_subscription_allowed ?? false,
		is_verify_enabled: project.is_verify_enabled ?? false,
		is_verify_on_finish_enabled: project.is_verify_on_finish_enabled ?? false,
		language: projectLanguageForForm(project.language),
		verification_topics: selectedTopics,
	};
}

/** Only the given fields of a value set. */
export const pick = <K extends PortalField>(
	values: PortalFormValues,
	fields: readonly K[],
): Pick<PortalFormValues, K> =>
	Object.fromEntries(fields.map((f) => [f, values[f]])) as Pick<
		PortalFormValues,
		K
	>;

/** The project fields the portal editor reads, for its one project query. */
export const PORTAL_PROJECT_FIELDS = [
	"id",
	"updated_at",
	"language",
	"name",
	"context",
	"workspace_id",
	"default_conversation_ask_for_participant_name",
	"conversation_ask_for_participant_name_label",
	"default_conversation_ask_for_participant_email",
	"default_conversation_description",
	"default_conversation_finish_text",
	"default_conversation_title",
	"default_conversation_transcript_prompt",
	"default_conversation_tutorial_slug",
	"get_reply_mode",
	"get_reply_prompt",
	"is_get_reply_enabled",
	"is_get_reply_cross_pollination_enabled",
	"is_verify_enabled",
	"is_verify_on_finish_enabled",
	"selected_verification_key_list",
	"is_project_notification_subscription_allowed",
	"anonymize_transcripts",
	"enable_ai_title_and_tags",
	"conversation_title_prompt",
	"is_dembrane_event_cta_enabled",
	{ tags: ["id", "created_at", "text", "sort"] },
] as const;
