import { t } from "@lingui/core/macro";
import { Badge, Group, Stack, Text } from "@mantine/core";
import { LightbulbIcon } from "@phosphor-icons/react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import type { ParsedInsightNote } from "./agenticToolActivity";

// Kept lowercase per brand: these read as quiet chips, not headings.
const kindLabel = (kind: ParsedInsightNote["kind"]): string => {
	switch (kind) {
		case "capability_gap":
			return t`capability gap`;
		case "friction":
			return t`friction`;
		case "wish":
			return t`wish`;
		case "praise":
			return t`praise`;
		default:
			return t`note`;
	}
};

/** A calm, read-only card showing what the assistant noted for the dembrane
 * team: the kind chip, the restated need, and any suggested capability. There
 * is nothing to apply here, so no button. */
export const InsightNoteCard = ({ note }: { note: ParsedInsightNote }) => {
	return (
		<SuggestionCardFrame compact testId="agentic-insight-note">
			<Stack gap="xs">
				<Group gap="xs" wrap="nowrap">
					<LightbulbIcon size={16} aria-hidden="true" />
					<Badge size="xs" variant="outline" radius="sm">
						{kindLabel(note.kind)}
					</Badge>
				</Group>
				<Text size="sm">{note.content}</Text>
				{note.suggestedCapability ? (
					<Text size="xs" c="dimmed">
						{note.suggestedCapability}
					</Text>
				) : null}
				<Text size="xs" c="dimmed">
					{t`noted for the dembrane team`}
				</Text>
			</Stack>
		</SuggestionCardFrame>
	);
};
