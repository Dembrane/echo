import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Text, Tooltip } from "@mantine/core";
import { IconThumbDown, IconThumbUp } from "@tabler/icons-react";
import type { PromptTemplateRatingResponse } from "@/lib/api";

type TemplateRatingPillsProps = {
	templateKey: string;
	messageId?: string;
	ratings: PromptTemplateRatingResponse[];
	onRate: (payload: {
		prompt_template_id: string;
		rating: 1 | 2;
		chat_message_id?: string | null;
	}) => void;
	isRating?: boolean;
};

/**
 * Extracts the prompt_template_id from a template_key.
 * Returns null for built-in static templates (they don't have a "user:" prefix).
 */
function getPromptTemplateId(templateKey: string): string | null {
	if (templateKey.startsWith("user:")) {
		return templateKey.slice(5);
	}
	return null;
}

export const TemplateRatingPills = ({
	templateKey,
	messageId,
	ratings,
	onRate,
	isRating = false,
}: TemplateRatingPillsProps) => {
	const promptTemplateId = getPromptTemplateId(templateKey);

	// Only show rating for user-created templates
	if (!promptTemplateId) return null;

	// Find existing rating for this message+template combo
	const existingRating = ratings.find(
		(r) =>
			r.prompt_template_id === promptTemplateId &&
			r.chat_message_id === (messageId ?? null),
	);

	const currentRating = existingRating?.rating ?? null;

	const handleRate = (rating: 1 | 2) => {
		onRate({
			prompt_template_id: promptTemplateId,
			rating,
			chat_message_id: messageId ?? null,
		});
	};

	return (
		<Group gap={4} align="center">
			<Text size="xs" c="dimmed">
				<Trans>Rate this prompt:</Trans>
			</Text>
			<Tooltip label="Good prompt">
				<ActionIcon
					size="xs"
					variant={currentRating === 2 ? "filled" : "subtle"}
					color={currentRating === 2 ? "green" : "gray"}
					onClick={() => handleRate(2)}
					disabled={isRating}
				>
					<IconThumbUp size={12} />
				</ActionIcon>
			</Tooltip>
			<Tooltip label="Needs improvement">
				<ActionIcon
					size="xs"
					variant={currentRating === 1 ? "filled" : "subtle"}
					color={currentRating === 1 ? "red" : "gray"}
					onClick={() => handleRate(1)}
					disabled={isRating}
				>
					<IconThumbDown size={12} />
				</ActionIcon>
			</Tooltip>
		</Group>
	);
};
