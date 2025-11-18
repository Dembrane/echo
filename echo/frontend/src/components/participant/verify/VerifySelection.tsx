import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useParticipantProjectById } from "../hooks";
import { startCooldown } from "../refine/hooks/useRefineSelectionCooldown";
import { useVerificationTopics } from "./hooks";

const LANGUAGE_TO_LOCALE: Record<string, string> = {
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	nl: "nl-NL",
};

export const TOPIC_ICON_MAP: Record<string, string> = {
	actions: "↗️",
	agreements: "✅",
	disagreements: "⚠️",
	gems: "🔍",
	moments: "🚀",
	truths: "👀",
};

export const VerifySelection = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [selectedOption, setSelectedOption] = useState<string | null>(null);
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const topicsQuery = useVerificationTopics(projectId);

	const projectLanguage = projectQuery.data?.language ?? "en";
	const languageLocale =
		LANGUAGE_TO_LOCALE[projectLanguage] ?? LANGUAGE_TO_LOCALE.en;

	const selectedTopics = topicsQuery.data?.selected_topics ?? [];
	const availableTopics = topicsQuery.data?.available_topics ?? [];

	const availableOptions = availableTopics
		.filter((topic) => selectedTopics.includes(topic.key))
		.map((topic) => {
			const translations = topic.translations ?? {};
			const localizedLabel =
				translations[languageLocale]?.label ??
				translations["en-US"]?.label ??
				topic.key;

			const icon =
				TOPIC_ICON_MAP[topic.key] ??
				(topic.icon && !topic.icon.startsWith(":") ? topic.icon : undefined) ??
				"•";

			return {
				icon,
				key: topic.key,
				label: localizedLabel,
			};
		});

	const isLoading = projectQuery.isLoading || topicsQuery.isLoading;

	useEffect(() => {
		if (
			selectedOption &&
			selectedTopics.length > 0 &&
			!selectedTopics.includes(selectedOption)
		) {
			setSelectedOption(null);
		}
	}, [selectedOption, selectedTopics]);

	const handleNext = () => {
		if (!selectedOption || !conversationId) return;

		// Start cooldown for verify
		startCooldown(conversationId, "verify");

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
					{isLoading && (
						<Text size="sm" c="dimmed">
							<Trans>Loading verification topics…</Trans>
						</Text>
					)}
					{!isLoading && availableOptions.length === 0 && (
						<Text size="sm" c="dimmed">
							<Trans>
								No verification topics are configured for this project.
							</Trans>
						</Text>
					)}
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
				rightSection={
					isLoading ? null : <IconArrowRight size={20} className="ml-1" />
				}
				disabled={!selectedOption || isLoading}
			>
				{isLoading ? (
					<Trans>Loading…</Trans>
				) : (
					<Trans id="participant.verify.selection.button.next">Next</Trans>
				)}
			</Button>
		</Stack>
	);
};
