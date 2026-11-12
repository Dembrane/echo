import type { VerificationTopicsResponse } from "@/lib/api";
import { localeForLanguage } from "@/lib/locale";
import {
	LEGAL_BASES,
	LIMITS,
	PREVIEW_LANGUAGES,
	PREVIEW_MESSAGE,
	PREVIEW_VERSION,
	type PreviewHighlight,
	type PreviewMessage,
	type PreviewProject,
	type PreviewResult,
	type PreviewScreen,
	TUTORIAL_SLUGS,
	webUrl,
} from "@/lib/portalPreview/protocol";
import type { PortalFormValues } from "../portalForm";
import { exampleResult } from "./examples";

export interface PreviewLegal {
	legal_basis: string | null | undefined;
	privacy_policy_url: string | null | undefined;
	organiser_name: string | null | undefined;
}

interface Input {
	values: PortalFormValues;
	tags: readonly { id: string; text: string | null }[];
	legal: PreviewLegal | null;
	topics: VerificationTopicsResponse | undefined;
	screen: PreviewScreen;
	highlight: PreviewHighlight | null;
	/**
	 * A real result from "Try it" (ECHO-1061), for the Explore reply or the Verify draft.
	 * Otherwise each shows the hand-written example for the mode or the first chosen topic.
	 */
	tried?: { kind: "explore" | "verify"; result: PreviewResult } | null;
	/** Counts the host's moves; a new one starts the screen again (see PreviewMessage). */
	reset?: number;
}

const cut = (s: string | null | undefined, max: number) =>
	(s ?? "").slice(0, max);

/**
 * What the dashboard sends the portal preview (ECHO-1060): the host's values as they are
 * now, saved or not, shaped to the protocol's limits, so the portal's check never refuses
 * a message the dashboard meant to send.
 */
export function buildPreviewMessage({
	values,
	tags,
	legal,
	topics,
	screen,
	highlight,
	tried,
	reset = 0,
}: Input): PreviewMessage {
	const language = (PREVIEW_LANGUAGES as readonly string[]).includes(
		values.language,
	)
		? (values.language as PreviewProject["language"])
		: "en";
	const locale = localeForLanguage(language);
	const tutorial = TUTORIAL_SLUGS.find(
		(s) => s === values.default_conversation_tutorial_slug,
	);
	const basis = (LEGAL_BASES as readonly string[]).includes(
		legal?.legal_basis ?? "",
	)
		? (legal?.legal_basis as PreviewProject["legal_basis"])
		: "client-managed";
	const policy = legal?.privacy_policy_url ?? null;
	const project: PreviewProject = {
		anonymize_transcripts: values.anonymize_transcripts,
		conversation_ask_for_participant_name_label: cut(
			values.conversation_ask_for_participant_name_label,
			LIMITS.label,
		),
		default_conversation_ask_for_participant_email:
			values.default_conversation_ask_for_participant_email,
		default_conversation_ask_for_participant_name:
			values.default_conversation_ask_for_participant_name,
		default_conversation_description: cut(
			values.default_conversation_description,
			LIMITS.longText,
		),
		default_conversation_finish_text: cut(
			values.default_conversation_finish_text,
			LIMITS.longText,
		),
		default_conversation_title: cut(
			values.default_conversation_title,
			LIMITS.title,
		),
		default_conversation_tutorial_slug: tutorial ?? "none",
		is_dembrane_event_cta_enabled: values.is_dembrane_event_cta_enabled,
		is_get_reply_enabled: values.is_get_reply_enabled,
		is_project_notification_subscription_allowed:
			values.is_project_notification_subscription_allowed,
		is_verify_enabled: values.is_verify_enabled,
		is_verify_on_finish_enabled: values.is_verify_on_finish_enabled,
		language,
		legal_basis: basis,
		organiser_name: legal?.organiser_name
			? cut(legal.organiser_name, LIMITS.title)
			: null,
		privacy_policy_url: webUrl(policy),
		tags: tags.slice(0, LIMITS.tags).map((tag) => ({
			id: cut(tag.id, LIMITS.tagText),
			text: cut(tag.text, LIMITS.tagText),
		})),
	};

	const selected = new Set(values.verification_topics ?? []);
	const previewTopics = (topics?.available_topics ?? [])
		.filter((topic) => selected.has(topic.key))
		.slice(0, LIMITS.topics)
		.map((topic) => ({
			key: cut(topic.key, LIMITS.label),
			label: cut(
				topic.translations?.[locale]?.label ??
					topic.translations?.["en-US"]?.label ??
					topic.key,
				LIMITS.title,
			),
		}));

	// Both, whichever screen is open: the host can click through to either (ECHO-1062).
	const explore =
		tried?.kind === "explore"
			? tried.result
			: exampleResult("explore", values.get_reply_mode, language);
	const verify =
		tried?.kind === "verify"
			? tried.result
			: exampleResult("verify", previewTopics[0]?.key ?? "heard", language);

	return {
		explore,
		highlight,
		project,
		reset,
		screen,
		topics: previewTopics,
		type: PREVIEW_MESSAGE,
		verify,
		version: PREVIEW_VERSION,
	};
}
