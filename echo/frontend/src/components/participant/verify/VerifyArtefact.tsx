import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Group,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconPencil, IconPlayerPause, IconVolume } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Logo } from "../../common/Logo";
import { Markdown } from "../../common/Markdown";
import { MarkdownWYSIWYG } from "../../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { useParticipantProjectById } from "../hooks";
import {
	useGenerateVerificationArtefact,
	useUpdateVerificationArtefact,
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

const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

export const VerifyArtefact = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();
	const queryClient = useQueryClient();

	const selectedOptionKey = searchParams.get("key");
	const updateArtefactMutation = useUpdateVerificationArtefact();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const topicsQuery = useVerificationTopics(projectId);

	// Use query to automatically fetch or generate the artefact
	const artefactQuery = useGenerateVerificationArtefact(
		conversationId,
		selectedOptionKey ?? undefined,
		!!(
			selectedOptionKey &&
			topicsQuery.data?.selected_topics?.includes(selectedOptionKey)
		),
	);

	const [showInstructions, setShowInstructions] = useState(true);
	const [isApproving, setIsApproving] = useState(false);
	const [isRevising, setIsRevising] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [editedContent, setEditedContent] = useState<string>("");
	const [isPlaying, setIsPlaying] = useState(false);
	const [lastReviseTime, setLastReviseTime] = useState<number | null>(null);
	const [reviseTimeRemaining, setReviseTimeRemaining] = useState<number>(0);
	const [localArtefactContent, setLocalArtefactContent] = useState<
		string | null
	>(null);

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const reviseTimerRef = useRef<NodeJS.Timeout | null>(null);

	const artefactContent =
		localArtefactContent ?? artefactQuery.data?.content ?? "";
	const generatedArtifactId = artefactQuery.data?.id ?? null;
	const readAloudUrl = artefactQuery.data?.read_aloud_stream_url ?? "";
	const artefactDateUpdated = artefactQuery.data?.date_created ?? null;

	const projectLanguage = projectQuery.data?.language ?? "en";
	const languageLocale =
		LANGUAGE_TO_LOCALE[projectLanguage] ?? LANGUAGE_TO_LOCALE.en;

	const availableTopics = topicsQuery.data?.available_topics ?? [];
	const selectedTopics = topicsQuery.data?.selected_topics ?? [];

	const selectedTopic = availableTopics.find(
		(topic) => topic.key === selectedOptionKey,
	);

	const selectedOptionLabel =
		selectedTopic?.translations?.[languageLocale]?.label ??
		selectedTopic?.translations?.["en-US"]?.label ??
		selectedTopic?.key ??
		t`verified`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: no need for navigate function in dependency
	useEffect(() => {
		if (
			!selectedOptionKey ||
			(topicsQuery.isSuccess && !selectedTopics.includes(selectedOptionKey))
		) {
			navigate(`/${projectId}/conversation/${conversationId}/verify`, {
				replace: true,
			});
		}
	}, [
		selectedOptionKey,
		selectedTopics,
		topicsQuery.isSuccess,
		projectId,
		conversationId,
	]);

	const handleNextFromInstructions = () => {
		setShowInstructions(false);
	};

	const handleApprove = async () => {
		if (
			!conversationId ||
			!selectedOptionKey ||
			!artefactContent ||
			!generatedArtifactId
		) {
			return;
		}

		setIsApproving(true);
		try {
			await updateArtefactMutation.mutateAsync({
				approvedAt: new Date().toISOString(),
				artifactId: generatedArtifactId,
				content: artefactContent,
				conversationId,
			});

			const conversationUrl = `/${projectId}/conversation/${conversationId}`;
			navigate(conversationUrl);

			// Show toast after navigation so it appears in the destination route's Toaster
			setTimeout(() => {
				toast.success(t`Artefact approved successfully!`);
				setIsApproving(false);
			}, 100);
		} catch (error) {
			toast.error(t`Failed to approve artefact. Please try again.`);
			console.error("error approving artefact: ", error);
		} finally {
			setIsApproving(false);
		}
	};

	const handleRevise = async () => {
		if (!conversationId || !selectedOptionKey || !generatedArtifactId) {
			return;
		}
		const timestampToUse = artefactDateUpdated;
		if (!timestampToUse) {
			toast.error(t`Something went wrong. Please try again.`);
			return;
		}
		setIsRevising(true);
		try {
			const updatedArtefact = await updateArtefactMutation.mutateAsync({
				artifactId: generatedArtifactId,
				conversationId,
				useConversation: {
					conversationId,
					timestamp: timestampToUse,
				},
			});

			setLastReviseTime(Date.now());

			// Clear local edits since we have fresh content from backend
			setLocalArtefactContent(null);

			// Update the query cache directly with the revised artifact
			queryClient.setQueryData(
				["verify", "artifact_by_topic", conversationId, selectedOptionKey],
				updatedArtefact,
			);

			toast.success(t`Artefact revised successfully!`);
		} catch (error) {
			toast.error(t`Failed to revise artefact. Please try again.`);
			console.error("error revising artefact: ", error);
		} finally {
			setIsRevising(false);
		}
	};

	const handleEdit = () => {
		setEditedContent(artefactContent);
		setIsEditing(true);
	};

	const handleCancelEdit = () => {
		setIsEditing(false);
		setEditedContent("");
	};

	const handleSaveEdit = () => {
		if (!editedContent) {
			return;
		}

		// Update local state only - backend save happens on approve
		setLocalArtefactContent(editedContent);
		setIsEditing(false);
		setEditedContent("");
		toast.success(t`Artefact updated successfully!`);
	};

	const handleReadAloud = () => {
		if (!readAloudUrl) return;

		if (!audioRef.current || audioRef.current.src !== readAloudUrl) {
			audioRef.current?.pause();
			audioRef.current = new Audio(readAloudUrl);
			audioRef.current.addEventListener("ended", () => {
				setIsPlaying(false);
			});
		}

		if (isPlaying) {
			audioRef.current.pause();
			setIsPlaying(false);
		} else {
			audioRef.current.play();
			setIsPlaying(true);
		}
	};

	useEffect(() => {
		if (lastReviseTime === null) return;

		const COOLDOWN_MS = 2 * 60 * 1000;

		const updateTimer = () => {
			const now = Date.now();
			const elapsed = now - lastReviseTime;
			const remaining = Math.max(0, COOLDOWN_MS - elapsed);
			setReviseTimeRemaining(remaining);
			if (remaining === 0 && reviseTimerRef.current) {
				clearInterval(reviseTimerRef.current);
				reviseTimerRef.current = null;
			}
		};

		updateTimer();
		reviseTimerRef.current = setInterval(updateTimer, 1000);

		return () => {
			if (reviseTimerRef.current) {
				clearInterval(reviseTimerRef.current);
				reviseTimerRef.current = null;
			}
		};
	}, [lastReviseTime]);

	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current = null;
			}
		};
	}, []);

	if (projectQuery.isError || topicsQuery.isError || artefactQuery.isError) {
		return (
			<Stack gap="md" align="center" justify="center" className="h-full">
				<Text c="red">
					<Trans id="participant.verify.artefact.error.message">
						Something went wrong while preparing the verification experience.
					</Trans>
				</Text>
				<Button
					variant="subtle"
					onClick={() =>
						navigate(`/${projectId}/conversation/${conversationId}/verify`, {
							replace: true,
						})
					}
				>
					<Trans id="participant.verify.artefact.action.button.go.back">
						Go back
					</Trans>
				</Button>
			</Stack>
		);
	}

	const isLoading =
		topicsQuery.isLoading ||
		projectQuery.isLoading ||
		artefactQuery.isLoading ||
		artefactQuery.isFetching;

	if (showInstructions) {
		return (
			<VerifyInstructions
				objectLabel={selectedOptionLabel}
				isLoading={isLoading}
				onNext={handleNextFromInstructions}
			/>
		);
	}

	return (
		<Stack gap="lg" className="h-full">
			<ScrollArea className="flex-grow">
				<Paper
					withBorder
					p="xl"
					radius="lg"
					className="border-2 border-gray-200"
				>
					{isRevising ? (
						<Stack gap="xl" align="center" justify="center" className="py-12">
							<div className="animate-spin">
								<Logo hideTitle h="48px" />
							</div>
							<Stack gap="sm" align="center">
								<Text size="xl" fw={600}>
									<Trans id="participant.verify.regenerating.artefact">
										Regenerating the artefact
									</Trans>
								</Text>
								<Text size="sm" c="dimmed">
									<Trans id="participant.verify.regenerating.artefact.description">
										This will just take a few moments
									</Trans>
								</Text>
							</Stack>
						</Stack>
					) : (
						<Stack gap="md">
							<Group justify="space-between" align="center" wrap="nowrap">
								<Title order={4} className="font-semibold">
									<Trans id="participant.verify.artefact.title">
										Artefact: {selectedOptionLabel}
									</Trans>
								</Title>
								{readAloudUrl && (
									<ActionIcon
										size="lg"
										variant="subtle"
										color="gray"
										onClick={handleReadAloud}
										aria-label={isPlaying ? t`Pause reading` : t`Read aloud`}
									>
										{isPlaying ? (
											<IconPlayerPause size={20} />
										) : (
											<IconVolume size={20} />
										)}
									</ActionIcon>
								)}
							</Group>

							{isEditing ? (
								<MemoizedMarkdownWYSIWYG
									markdown={editedContent}
									onChange={setEditedContent}
								/>
							) : (
								<div>
									<Markdown className="prose-sm" content={artefactContent} />
								</div>
							)}
						</Stack>
					)}
				</Paper>
			</ScrollArea>

			<Group gap="md" className="w-full sticky bottom-[11%] bg-white py-2 px-1">
				{isEditing ? (
					<>
						<Button
							size="lg"
							radius="md"
							variant="default"
							className="flex-1"
							onClick={handleCancelEdit}
						>
							<Trans id="participant.verify.action.button.cancel">Cancel</Trans>
						</Button>
						<Button
							size="lg"
							radius="md"
							className="flex-1"
							onClick={handleSaveEdit}
						>
							<Trans id="participant.verify.action.button.save">Save</Trans>
						</Button>
					</>
				) : (
					<>
						<Button.Group className="flex-1">
							<Button
								size="lg"
								radius="md"
								variant="default"
								className="flex-1"
								onClick={handleRevise}
								disabled={
									isLoading ||
									isRevising ||
									isApproving ||
									reviseTimeRemaining > 0 ||
									!generatedArtifactId
								}
							>
								{reviseTimeRemaining > 0 ? (
									<>{Math.ceil(reviseTimeRemaining / 1000)}s</>
								) : (
									<Trans id="participant.verify.action.button.revise">
										Revise
									</Trans>
								)}
							</Button>
							<Button
								size="lg"
								radius="md"
								variant="default"
								onClick={handleEdit}
								px="sm"
								disabled={
									isRevising || isApproving || isLoading || !generatedArtifactId
								}
							>
								<IconPencil size={20} />
							</Button>
						</Button.Group>

						<Button
							size="lg"
							radius="md"
							className="flex-1"
							onClick={handleApprove}
							loading={isApproving}
							disabled={
								isApproving ||
								isRevising ||
								isLoading ||
								!generatedArtifactId ||
								!artefactContent
							}
						>
							<Trans id="participant.verify.action.button.approve">
								Approve
							</Trans>
						</Button>
					</>
				)}
			</Group>
		</Stack>
	);
};
