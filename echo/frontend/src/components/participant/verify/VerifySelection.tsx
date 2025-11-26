import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Logo } from "@/components/common/Logo";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useParticipantProjectById } from "../hooks";
import { startCooldown } from "../refine/hooks/useRefineSelectionCooldown";
import {
	useGenerateVerificationArtefactMutation,
	useVerificationTopics,
} from "./hooks";
import { VerifyInstructions } from "./VerifyInstructions";

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
	const [searchParams, setSearchParams] = useSearchParams();
	const [selectedOption, setSelectedOption] = useState<string | null>(null);
	const [instructionTopicKey, setInstructionTopicKey] = useState<string | null>(
		null,
	);
	const showInstructions = searchParams.get("instructions") === "true";
	const [generatedArtefactId, setGeneratedArtefactId] = useState<string | null>(
		null,
	);
	const abortControllerRef = useRef<AbortController | null>(null);
	const generateArtefactMutation = useGenerateVerificationArtefactMutation();
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

	useEffect(() => {
		return () => {
			if (abortControllerRef.current) {
				abortControllerRef.current.abort();
			}
		};
	}, []);

	const getOptionLabel = (key: string | null) => {
		if (!key) return t`Hidden gem`;
		return availableOptions.find((option) => option.key === key)?.label ?? key;
	};

	const handleGenerationFlow = async (topicKey: string) => {
		if (!conversationId) return;

		abortControllerRef.current = new AbortController();

		setGeneratedArtefactId(null);
		setInstructionTopicKey(topicKey);
		setSearchParams({ instructions: "true" });
		try {
			const artefact = await generateArtefactMutation.mutateAsync({
				conversationId,
				signal: abortControllerRef.current.signal,
				topicKey,
			});
			setGeneratedArtefactId(artefact.id);
			startCooldown(conversationId, "verify");
		} catch (error) {
			// Don't show error toast if request was aborted
			if (error instanceof Error && error.name === "CanceledError") {
				return;
			}

			console.error("error generating verification artefact", error);
			const label = getOptionLabel(topicKey);
			toast.error(t`Failed to generate ${label}. Please try again.`);

			setInstructionTopicKey(null);
			setSelectedOption(null);
			setSearchParams({});
		} finally {
			abortControllerRef.current = null;
		}
	};

	const handleNext = () => {
		if (!selectedOption || !conversationId) return;

		handleGenerationFlow(selectedOption);
	};

	const handleInstructionsNext = () => {
		if (
			!conversationId ||
			!projectId ||
			!instructionTopicKey ||
			!generatedArtefactId
		) {
			return;
		}

		const params = new URLSearchParams({
			artifact_id: generatedArtefactId,
		});

		navigate(
			`/${projectId}/conversation/${conversationId}/verify/approve?${params.toString()}`,
		);
	};

	if (showInstructions) {
		const objectLabel = getOptionLabel(instructionTopicKey);
		return (
			<VerifyInstructions
				objectLabel={objectLabel}
				isLoading={generateArtefactMutation.isPending}
				canProceed={
					!generateArtefactMutation.isPending && !!generatedArtefactId
				}
				onNext={handleInstructionsNext}
			/>
		);
	}

	return (
		<Stack gap="lg" className="h-full pt-10">
			{/* Main content */}
			<Stack gap="xl" className="flex-grow">
				<Title order={2} className="font-semibold">
					<Trans id="participant.concrete.selection.title">
						What do you want to make concrete?
					</Trans>
				</Title>

				{/* Options list */}
				<Group gap="md">
					{isLoading && (
						<Stack align="center" justify="center" className="w-full py-8">
							<div className="animate-spin">
								<Logo hideTitle h="48px" />
							</div>
						</Stack>
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
					<Trans id="participant.concrete.selection.button.next">Next</Trans>
				)}
			</Button>
		</Stack>
	);
};
