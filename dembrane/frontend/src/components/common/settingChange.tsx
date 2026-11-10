import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Text } from "@mantine/core";

/**
 * How a proposed settings change reads, shared by the assistant's proposal card
 * (chat/ProjectUpdateSuggestionCard) and the setup suggestions in the create flow
 * (project/setup-suggestions): the field's name in the portal editor's words, and a
 * value marked as the one being replaced or the one proposed.
 */

// Hosts see the portal editor's language, not backend field names.
export const FIELD_LABELS: Record<string, () => string> = {
	anonymize_transcripts: () => t`Anonymise transcripts`,
	context: () => t`Project context`,
	conversation_title_prompt: () => t`Title guidance`,
	default_conversation_ask_for_participant_email: () =>
		t`Ask participants for their email`,
	default_conversation_ask_for_participant_name: () =>
		t`Ask participants for their name`,
	default_conversation_description: () => t`Portal description`,
	default_conversation_finish_text: () => t`Portal finish message`,
	default_conversation_title: () => t`Portal title`,
	default_conversation_transcript_prompt: () => t`Key terms`,
	default_conversation_tutorial_slug: () => t`Portal tutorial`,
	enable_ai_title_and_tags: () => t`Automatic titles and draft tags`,
	get_reply_mode: () => t`Reply mode`,
	get_reply_prompt: () => t`Reply guidance`,
	host_guide: () => t`Host guide`,
	image_generation_model: () => t`Image style`,
	is_conversation_allowed: () => t`Portal open for new conversations`,
	is_get_reply_cross_pollination_enabled: () => t`Cross-pollination`,
	is_get_reply_enabled: () => t`Replies to participants`,
	is_project_notification_subscription_allowed: () =>
		t`Participant updates subscription`,
	is_verify_enabled: () => t`Participant verification`,
	is_verify_on_finish_enabled: () => t`Verification on the finish screen`,
	language: () => t`Portal language`,
	legal_basis: () => t`Legal basis`,
	name: () => t`Project name`,
	selected_verification_key_list: () => t`Verification topics`,
	tutorial_slug: () => t`Tutorial`,
};

export const fieldLabel = (field: string) =>
	FIELD_LABELS[field]?.() ??
	field.replace(/^default_conversation_/, "").replace(/_/g, " ");

export const isEmptyValue = (value: unknown) =>
	value === null || value === undefined || value === "";

/**
 * The three ways a fragment can read inside a value box, and the only place
 * they are defined. The word diff and the short-value line both pull from
 * here, so a marking can never drift between the long and short paths.
 *
 * Each mark carries a shape as well as a colour: the removal is struck
 * through, the addition is underlined. A background alone does not survive
 * greyscale (the green sits at about 97% luminance) or a colour-blind reader,
 * and the addition used to have nothing but that background.
 *
 * Unchanged text recedes on purpose. Marked and unmarked prose used to sit at
 * the same contrast, so a two word edit inside a paragraph read as one flat
 * block; dropping the surround to a mid grey makes the edit the first thing
 * the eye lands on, without inventing a colour the card does not already use.
 */
export const REMOVED_MARK =
	"bg-[var(--app-danger-tint)] text-[var(--app-danger-on-tint)] line-through decoration-[var(--app-danger)] decoration-2";
export const ADDED_MARK =
	"bg-[var(--app-success-tint)] text-[var(--app-success)] underline decoration-[var(--app-success)] decoration-2";
export const asDisplayString = (value: unknown) => {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

export const ValueText = ({
	value,
	kind,
}: {
	value: unknown;
	kind: "old" | "new";
}) => {
	if (isEmptyValue(value)) {
		// A description of the value, not the value itself. Italics used to carry
		// that difference and carried it to nobody; the words say it instead, and
		// the dimmed colour keeps them from reading as content.
		return (
			<Text size="sm" component="span" c="dimmed">
				{kind === "old" ? (
					<Trans>nothing here yet</Trans>
				) : (
					<Trans>emptied out</Trans>
				)}
			</Text>
		);
	}
	const display =
		typeof value === "boolean" ? (
			value ? (
				<Trans>on</Trans>
			) : (
				<Trans>off</Trans>
			)
		) : (
			asDisplayString(value)
		);
	return (
		<Text
			size="sm"
			component="span"
			className={`break-words ${kind === "old" ? REMOVED_MARK : ADDED_MARK}`}
		>
			{display}
		</Text>
	);
};
