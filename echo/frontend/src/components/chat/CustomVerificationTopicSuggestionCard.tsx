import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { toast } from "@/components/common/Toaster";
import {
	useCreateCustomTopicMutation,
	useVerificationTopicsQuery,
} from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";

export type CustomVerificationTopicSuggestion = {
	projectId: string;
	label: string;
	prompt: string;
	reason: string;
};

/**
 * Renders a proposeCustomVerificationTopic result as an in-chat card. The host
 * can fine-tune the label and prompt, then apply it through the normal custom
 * topic endpoint under their own session (the access ladder gates the write).
 *
 * Applied state is stateless: the card checks the live verification topics for
 * a custom topic matching the (edited) label and prompt, so a reload still
 * shows "Added" truthfully.
 */
export const CustomVerificationTopicSuggestionCard = ({
	suggestion,
}: {
	suggestion: CustomVerificationTopicSuggestion;
}) => {
	const createTopicMutation = useCreateCustomTopicMutation();
	const topicsQuery = useVerificationTopicsQuery(suggestion.projectId);

	const [label, setLabel] = useState(suggestion.label);
	const [prompt, setPrompt] = useState(suggestion.prompt);
	const [dismissed, setDismissed] = useState(false);

	const applied = useMemo(() => {
		const topics = topicsQuery.data?.available_topics ?? [];
		const targetLabel = label.trim().toLowerCase();
		const targetPrompt = prompt.trim();
		return topics.some((topic) => {
			if (!topic.is_custom) return false;
			const topicLabel = (topic.translations?.["en-US"]?.label ?? topic.key)
				.trim()
				.toLowerCase();
			return (
				topicLabel === targetLabel &&
				(topic.prompt ?? "").trim() === targetPrompt
			);
		});
	}, [topicsQuery.data, label, prompt]);

	const handleApply = async () => {
		const normalizedLabel = label.trim();
		const normalizedPrompt = prompt.trim();
		if (!normalizedLabel || !normalizedPrompt) {
			toast.error(t`Add a name and a prompt before applying.`);
			return;
		}
		try {
			await createTopicMutation.mutateAsync({
				payload: { label: normalizedLabel, prompt: normalizedPrompt },
				projectId: suggestion.projectId,
			});
			await topicsQuery.refetch();
		} catch {
			// The mutation surfaces its own error toast.
		}
	};

	if (applied) {
		return (
			<SuggestionCardFrame
				compact
				testId="agentic-verification-topic-suggestion"
			>
				<Group gap="xs" wrap="nowrap">
					<IconCheck
						size={16}
						className="shrink-0"
						style={{ color: "var(--mantine-color-primary-7)" }}
					/>
					<Text size="sm">
						<Trans>This verification prompt is added to your project.</Trans>
					</Text>
				</Group>
			</SuggestionCardFrame>
		);
	}

	return (
		<SuggestionCardFrame testId="agentic-verification-topic-suggestion">
			<Stack gap="sm">
				<Group justify="space-between" wrap="nowrap">
					<Text size="sm" fw={600}>
						<Trans>Suggested verification prompt</Trans>
					</Text>
					{dismissed && (
						<Badge size="xs" variant="outline">
							<Trans>Dismissed</Trans>
						</Badge>
					)}
				</Group>
				{suggestion.reason && <Text size="xs">{suggestion.reason}</Text>}
				{!dismissed && (
					<Text size="xs" fs="italic" c="graphite.6">
						<Trans>
							Review and edit below. This adds a check that runs against each
							conversation. Verification must be enabled for it to run. Nothing
							changes until you add it.
						</Trans>
					</Text>
				)}

				{!dismissed && (
					<Stack gap="sm">
						<TextInput
							label={t`Name`}
							value={label}
							onChange={(event) => setLabel(event.currentTarget.value)}
							{...testId("verification-topic-label-input")}
						/>
						<Textarea
							label={t`Prompt`}
							autosize
							minRows={2}
							maxRows={8}
							value={prompt}
							onChange={(event) => setPrompt(event.currentTarget.value)}
							{...testId("verification-topic-prompt-input")}
						/>
					</Stack>
				)}

				<Group justify="flex-end" gap="xs">
					{!dismissed && (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(true)}
						>
							<Trans>Dismiss</Trans>
						</Button>
					)}
					{dismissed ? (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(false)}
						>
							<Trans>Review again</Trans>
						</Button>
					) : (
						<Button
							size="xs"
							loading={createTopicMutation.isPending}
							onClick={() => void handleApply()}
							{...testId("verification-topic-apply-button")}
						>
							<Trans>Add verification prompt</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</SuggestionCardFrame>
	);
};
