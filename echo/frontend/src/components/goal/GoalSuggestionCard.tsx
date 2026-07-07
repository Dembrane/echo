import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { useSaveProjectGoalMutation } from "@/components/goal/hooks";
import { testId } from "@/lib/testUtils";

export type GoalSuggestion = {
	projectId: string;
	content: string;
};

export const GoalSuggestionCard = ({
	suggestion,
	chatId,
}: {
	suggestion: GoalSuggestion;
	chatId?: string;
}) => {
	const saveGoalMutation = useSaveProjectGoalMutation(suggestion.projectId);
	const [dismissed, setDismissed] = useState(false);
	const [applied, setApplied] = useState(false);

	const handleApply = async () => {
		const content = suggestion.content.trim();
		if (!content) {
			toast.error(t`Add goal text before applying.`);
			return;
		}
		try {
			// A goal applied from the assistant's proposal keeps its
			// interview provenance (and the chat it came from).
			await saveGoalMutation.mutateAsync({
				chat_id: chatId,
				content,
				set_by: "interview",
			});
			setApplied(true);
		} catch {
			// The mutation surfaces its own error toast.
		}
	};

	if (applied) {
		return (
			<Box className="flex justify-start">
				<Paper
					className="w-full max-w-full rounded-md border border-slate-200/80 px-3 py-2 shadow-none md:max-w-[80%]"
					{...testId("agentic-goal-suggestion-applied")}
				>
					<Group gap="xs" wrap="nowrap">
						<IconCheck size={16} className="shrink-0 text-green-800" />
						<Text size="sm">
							<Trans>Saved as this project's goal.</Trans>
						</Text>
					</Group>
				</Paper>
			</Box>
		);
	}

	return (
		<Box className="flex justify-start">
			<Paper
				className="w-full max-w-full rounded-md border border-slate-200/80 px-3 py-3 shadow-none md:max-w-[80%]"
				{...testId("agentic-goal-suggestion")}
			>
				<Stack gap="sm">
					<Group justify="space-between" wrap="nowrap">
						<Text size="sm" fw={500}>
							<Trans>Suggested project goal</Trans>
						</Text>
						{dismissed ? (
							<Badge color="gray" variant="light">
								<Trans>Dismissed</Trans>
							</Badge>
						) : null}
					</Group>

					{!dismissed ? (
						<Text size="sm" fs="italic" style={{ whiteSpace: "pre-wrap" }}>
							"{suggestion.content.trim()}"
						</Text>
					) : null}

					<Group justify="flex-end" gap="xs">
						{!dismissed ? (
							<Button
								variant="subtle"
								size="xs"
								onClick={() => setDismissed(true)}
							>
								<Trans>Dismiss</Trans>
							</Button>
						) : (
							<Button
								variant="subtle"
								size="xs"
								onClick={() => setDismissed(false)}
							>
								<Trans>Review again</Trans>
							</Button>
						)}
						{!dismissed ? (
							<Button
								size="xs"
								loading={saveGoalMutation.isPending}
								onClick={() => void handleApply()}
								{...testId("goal-proposal-apply-button")}
							>
								<Trans>Apply</Trans>
							</Button>
						) : null}
					</Group>
				</Stack>
			</Paper>
		</Box>
	);
};
