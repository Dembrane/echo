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

// A short, host-referenceable handle: the host can say "edit insight a1b2".
const shortInsightId = (insightId: string): string =>
	insightId.replace(/[^a-z0-9]/gi, "").slice(0, 4) || insightId.slice(0, 4);

/** A calm, read-only card showing what the assistant noted for the dembrane
 * team: the kind chip, a short id suffix the host can reference, the restated
 * need, and any suggested capability. An amended note carries an "updated" chip;
 * a withdrawn one mutes and shows a "retracted" chip with the reason. There is
 * nothing to apply here, so no button. */
export const InsightNoteCard = ({ note }: { note: ParsedInsightNote }) => {
	const retracted = note.mode === "retracted";
	const edited = note.mode === "edited";
	return (
		<SuggestionCardFrame compact testId="agentic-insight-note">
			<Stack gap="xs">
				<Group gap="xs" wrap="nowrap">
					<LightbulbIcon
						size={16}
						aria-hidden="true"
						opacity={retracted ? 0.5 : 1}
					/>
					<Badge
						size="xs"
						variant="outline"
						radius="sm"
						c={retracted ? "dimmed" : undefined}
					>
						{kindLabel(note.kind)}
					</Badge>
					{edited ? (
						<Badge size="xs" variant="light" radius="sm">
							{t`updated`}
						</Badge>
					) : null}
					{retracted ? (
						<Badge size="xs" variant="light" color="gray" radius="sm">
							{t`retracted`}
						</Badge>
					) : null}
					{note.insightId ? (
						<Text size="xs" c="dimmed">
							{t`insight ${shortInsightId(note.insightId)}`}
						</Text>
					) : null}
				</Group>
				<Text size="sm" c={retracted ? "dimmed" : undefined}>
					{note.content}
				</Text>
				{note.suggestedCapability && !retracted ? (
					<Text size="xs" c="dimmed">
						{note.suggestedCapability}
					</Text>
				) : null}
				{retracted && note.reason ? (
					<Text size="xs" c="dimmed">
						{t`reason: ${note.reason}`}
					</Text>
				) : null}
				<Text size="xs" c="dimmed">
					{retracted
						? t`retracted for the dembrane team`
						: t`noted for the dembrane team`}
				</Text>
			</Stack>
		</SuggestionCardFrame>
	);
};
