import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Skeleton,
	Stack,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";

import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";
import { useParticipantProjectById } from "../hooks";
import { startCooldown } from "../refine/hooks/useRefineSelectionCooldown";
import {
	useGenerateVerificationArtefactMutation,
	useVerificationTopics,
} from "./hooks";
import { VerifyInstructions } from "./VerifyInstructions";

type LanguageCode = "de" | "en" | "es" | "fr" | "nl" | "it" | "uk" | "cs";

const LANGUAGE_TO_LOCALE: Record<LanguageCode, string> = {
	cs: "cs-CZ",
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	it: "it-IT",
	nl: "nl-NL",
	uk: "uk-UA",
};

const localeFromLanguage = (language?: string) => {
	if (!language) return undefined;
	const iso = language.includes("-") ? language.split("-")[0] : language;
	return LANGUAGE_TO_LOCALE[iso as LanguageCode];
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
	const { iso639_1: uiLanguageIso } = useLanguage();
	const languageLocale =
		localeFromLanguage(uiLanguageIso) ??
		localeFromLanguage(projectLanguage) ??
		LANGUAGE_TO_LOCALE.en;

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

			return {
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

		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
		}
		const controller = new AbortController();
		abortControllerRef.current = controller;

		setGeneratedArtefactId(null);
		setInstructionTopicKey(topicKey);
		setSearchParams({ instructions: "true" });
		try {
			const artefact = await generateArtefactMutation.mutateAsync({
				conversationId,
				signal: controller.signal,
				topicKey,
			});
			setGeneratedArtefactId(artefact.id);
			startCooldown(conversationId, "verify");
		} catch (error) {
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
			if (abortControllerRef.current === controller) {
				abortControllerRef.current = null;
			}
		}
	};

	const singleTopicKey =
		availableOptions.length === 1 ? availableOptions[0].key : null;

	const [hasAutoTriedSingle, setHasAutoTriedSingle] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: handleGenerationFlow is intentionally excluded; auto-skip should only react to data/route changes, not function-identity changes.
	useEffect(() => {
		if (hasAutoTriedSingle) return;
		if (!isLoading && !showInstructions && singleTopicKey && conversationId) {
			setHasAutoTriedSingle(true);
			handleGenerationFlow(singleTopicKey);
		}
	}, [
		hasAutoTriedSingle,
		isLoading,
		singleTopicKey,
		conversationId,
		showInstructions,
	]);

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

	if (
		isLoading ||
		(singleTopicKey && !showInstructions && !hasAutoTriedSingle)
	) {
		return (
			<Stack gap="md" className="h-full pt-10">
				<Skeleton height={32} width="60%" />
				<Group gap="sm">
					<Skeleton height={48} width={120} />
					<Skeleton height={48} width={120} />
					<Skeleton height={48} width={120} />
				</Group>
			</Stack>
		);
	}

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
		<Stack
			gap="lg"
			className="h-full pt-10"
			{...testId("portal-verify-selection-container")}
		>
			{/* Main content */}
			<Stack gap="xl" className="flex-grow">
				<Title order={2}>
					<Trans id="participant.verify.selection.title">
						What do you want to verify?
					</Trans>
				</Title>

				{/* Options list */}
				<Group gap="sm">
					{availableOptions.length === 0 && (
						<Text size="sm" c="dimmed">
							<Trans>
								No verification topics are configured for this project.
							</Trans>
						</Text>
					)}
					{availableOptions.map((option) => (
						<UnstyledButton
							key={option.key}
							onClick={() => setSelectedOption(option.key)}
							className="app-do px-4 py-3"
							data-selected={selectedOption === option.key || undefined}
							aria-pressed={selectedOption === option.key}
							{...testId(`portal-verify-topic-${option.key}`)}
						>
							<Text size="sm">{option.label}</Text>
						</UnstyledButton>
					))}
				</Group>
			</Stack>

			{/* Next button */}
			<Button
				size="lg"
				variant="filled"
				onClick={handleNext}
				className="w-full"
				rightSection={<ArrowRightIcon size={20} />}
				disabled={!selectedOption}
				{...testId("portal-verify-selection-next-button")}
			>
				<Trans id="participant.verify.selection.button.next">Continue</Trans>
			</Button>
		</Stack>
	);
};
