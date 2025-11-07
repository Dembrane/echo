import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useState } from "react";
import { useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useParticipantProjectById } from "../hooks";

// Verify options that match the verification_topics field
export const VERIFY_OPTIONS = [
	{
		icon: "✅",
		key: "agreements",
		label: t`What we actually agreed on`,
	},
	{
		icon: "🔍",
		key: "gems",
		label: t`Hidden gems`,
	},
	{
		icon: "👀",
		key: "truths",
		label: t`Painful truths`,
	},
	{
		icon: "🚀",
		key: "moments",
		label: t`Breakthrough moments`,
	},
	{
		icon: "↗️",
		key: "actions",
		label: t`What we think should happen`,
	},
	{
		icon: "⚠️",
		key: "disagreements",
		label: t`Moments we agreed to disagree`,
	},
];

export const VerifySelection = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [selectedOption, setSelectedOption] = useState<string | null>(null);
	const projectQuery = useParticipantProjectById(projectId ?? "");

	// Filter options based on enabled topics
	const enabledTopics = projectQuery.data?.verification_topics ?? [];
	const availableOptions = VERIFY_OPTIONS.filter((option) =>
		enabledTopics.includes(option.key),
	);

	const handleNext = () => {
		if (!selectedOption) return;

		// Navigate directly to approve route with URL param
		navigate(
			`/${projectId}/conversation/${conversationId}/verify/approve?key=${selectedOption}`,
		);
	};

	return (
		<Stack gap="lg" className="h-full">
			{/* Main content */}
			<Stack gap="xl" className="flex-grow">
				<Title order={2} className="text-2xl font-semibold">
					<Trans id="participant.verify.selection.title">
						What do you want to verify?
					</Trans>
				</Title>

				{/* Options list */}
				<Group gap="md">
					{availableOptions.map((option) => (
						<Box
							key={option.key}
							onClick={() => setSelectedOption(option.key)}
							className={`cursor-pointer rounded-3xl border-2 px-4 py-3 transition-all ${
								selectedOption === option.key
									? "border-blue-500 bg-blue-50"
									: "border-gray-300 bg-white hover:border-gray-400"
							}`}
						>
							<Group gap="sm" align="center">
								<span className="text-xl">{option.icon}</span>
								<span className="text-base font-medium">{option.label}</span>
							</Group>
						</Box>
					))}
				</Group>
			</Stack>

			{/* Next button */}
			<Button
				size="lg"
				radius="3xl"
				onClick={handleNext}
				className="w-full"
				rightSection={<IconArrowRight size={20} className="ml-1" />}
				disabled={!selectedOption}
			>
				<Trans id="participant.verify.selection.button.next">Next</Trans>
			</Button>
		</Stack>
	);
};
