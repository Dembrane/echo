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
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Logo } from "../../common/Logo";
import { Markdown } from "../../common/Markdown";
import { MarkdownWYSIWYG } from "../../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import {
	useConversationChunksQuery,
	useParticipantProjectById,
} from "../hooks";
import {
	useGenerateVerificationArtefact,
	useUpdateVerificationArtefact,
	useVerificationTopics,
} from "./hooks";
import { VerifyInstructions } from "./VerifyInstructions";

type ConversationChunkLike = {
	timestamp?: string | null;
};

const LANGUAGE_TO_LOCALE: Record<string, string> = {
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	nl: "nl-NL",
};

const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

const computeLatestTimestamp = (
	chunks: ConversationChunkLike[] | undefined,
): string | null => {
	if (!chunks || chunks.length === 0) {
		return null;
	}

	let latest: string | null = null;
	for (const chunk of chunks) {
		if (!chunk.timestamp) continue;
		const currentIso = new Date(chunk.timestamp).toISOString();
		if (!latest || new Date(currentIso) > new Date(latest)) {
			latest = currentIso;
		}
	}
	return latest;
};

export const VerifyArtefact = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();
	const queryClient = useQueryClient();

	const generateArtefactMutation = useGenerateVerificationArtefact();
	const updateArtefactMutation = useUpdateVerificationArtefact();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const topicsQuery = useVerificationTopics(projectId);
	const chunksQuery = useConversationChunksQuery(projectId, conversationId);

	const selectedOptionKey = searchParams.get("key");

	const [showInstructions, setShowInstructions] = useState(true);
	const [isApproving, setIsApproving] = useState(false);
	const [isRevising, setIsRevising] = useState(false);
	const [artefactContent, setArtefactContent] = useState<string>("");
	const [hasGenerated, setHasGenerated] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [editedContent, setEditedContent] = useState<string>("");
	const [readAloudUrl, setReadAloudUrl] = useState<string>("");
	const [isPlaying, setIsPlaying] = useState(false);
	const [lastReviseTime, setLastReviseTime] = useState<number | null>(null);
	const [reviseTimeRemaining, setReviseTimeRemaining] = useState<number>(0);
	const [generatedArtifactId, setGeneratedArtifactId] = useState<string | null>(
		null,
	);
	const [contextTimestamp, setContextTimestamp] = useState<string | null>(null);

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const reviseTimerRef = useRef<NodeJS.Timeout | null>(null);

	const latestChunkTimestamp = useMemo(
		() => computeLatestTimestamp(chunksQuery.data as ConversationChunkLike[]),
		[chunksQuery.data],
	);

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
		navigate,
		projectId,
		conversationId,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: regenerate only when generating first artefact
	useEffect(() => {
		if (
			!selectedOptionKey ||
			!conversationId ||
			hasGenerated ||
			topicsQuery.isLoading ||
			!selectedTopics.includes(selectedOptionKey)
		) {
			return;
		}

		const generateArtefact = async () => {
			try {
				setHasGenerated(true);
				setGeneratedArtifactId(null);
				setReadAloudUrl("");

				const response = await generateArtefactMutation.mutateAsync({
					conversationId,
					topicList: [selectedOptionKey],
				});

				if (response && response.length > 0) {
					const artifact = response[0];
					setArtefactContent(artifact.content);
					setGeneratedArtifactId(artifact.id);
					setReadAloudUrl(artifact.read_aloud_stream_url || "");
					if (latestChunkTimestamp) {
						setContextTimestamp(latestChunkTimestamp);
					}
				}
			} catch (error) {
				console.error("Failed to generate artifact:", error);
				setHasGenerated(false);
			}
		};

		generateArtefact();
	}, [
		selectedOptionKey,
		conversationId,
		hasGenerated,
		topicsQuery.isLoading,
		selectedTopics,
		generateArtefactMutation,
		latestChunkTimestamp,
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
				artifactId: generatedArtifactId,
				conversationId,
				content: artefactContent,
				approvedAt: new Date().toISOString(),
				successMessage: t`Artefact approved successfully!`,
			});

			const conversationUrl = `/${projectId}/conversation/${conversationId}`;
			navigate(conversationUrl);
		} finally {
			setIsApproving(false);
		}
	};

	const handleRevise = async () => {
		if (!conversationId || !selectedOptionKey || !generatedArtifactId) {
			return;
		}
		const timestampToUse = contextTimestamp ?? latestChunkTimestamp;
		if (!timestampToUse) {
			toast.error("No feedback available yet. Try again after sharing updates.");
			return;
		}

		setIsRevising(true);
		try {
			const response = await updateArtefactMutation.mutateAsync({
				artifactId: generatedArtifactId,
				conversationId,
				useConversation: {
					conversationId,
					timestamp: timestampToUse,
				},
				successMessage: t`Artefact revised successfully!`,
			});

			if (response) {
				setArtefactContent(response.content);
				setGeneratedArtifactId(response.id);
				setReadAloudUrl(response.read_aloud_stream_url || "");
			}

			setLastReviseTime(Date.now());
			const refreshed = await chunksQuery.refetch();
			await queryClient.invalidateQueries({
				queryKey: ["participant", "conversation_chunks", conversationId],
			});

			const updatedLatest = computeLatestTimestamp(
				(refreshed.data ?? chunksQuery.data) as ConversationChunkLike[],
			);
			setContextTimestamp(updatedLatest ?? timestampToUse);
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

	const handleSaveEdit = async () => {
		if (!editedContent || !generatedArtifactId || !conversationId) {
			return;
		}
		try {
			const response = await updateArtefactMutation.mutateAsync({
				artifactId: generatedArtifactId,
				conversationId,
				content: editedContent,
				successMessage: t`Artefact updated successfully!`,
			});
			if (response) {
				setArtefactContent(response.content);
			} else {
				setArtefactContent(editedContent);
			}
			setIsEditing(false);
			setEditedContent("");
		} catch (error) {
			console.error("Failed to update artefact content:", error);
		}
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

	if (projectQuery.isError || topicsQuery.isError) {
		return (
			<Stack gap="md" align="center" justify="center" className="h-full">
				<Text c="red">
					<Trans>
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
					<Trans>Go back</Trans>
				</Button>
			</Stack>
		);
	}

	const isInitialLoading =
		topicsQuery.isLoading ||
		projectQuery.isLoading ||
		generateArtefactMutation.isPending ||
		(!generatedArtifactId && !artefactContent);

	if (showInstructions) {
		return (
			<VerifyInstructions
				objectLabel={selectedOptionLabel}
				isLoading={isInitialLoading}
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
							loading={updateArtefactMutation.isPending}
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
									isInitialLoading ||
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
									isRevising ||
									isApproving ||
									isInitialLoading ||
									!generatedArtifactId
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
								isInitialLoading ||
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
