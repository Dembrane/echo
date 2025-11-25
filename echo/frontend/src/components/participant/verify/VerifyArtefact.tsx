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
import { AxiosError } from "axios";
import { memo, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { useCooldown } from "@/hooks/useCooldown";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Logo } from "../../common/Logo";
import { Markdown } from "../../common/Markdown";
import { MarkdownWYSIWYG } from "../../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { useParticipantProjectById } from "../hooks";
import {
	useUpdateVerificationArtefact,
	useVerificationArtefactById,
	useVerificationTopics,
} from "./hooks";
import { VerifyArtefactError } from "./VerifyArtefactError";
import { VerifyArtefactLoading } from "./VerifyArtefactLoading";

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

	const updateArtefactMutation = useUpdateVerificationArtefact();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const topicsQuery = useVerificationTopics(projectId);

	// Get artifact_id from URL to fetch the specific artifact
	const selectedArtifactId = searchParams.get("artifact_id");
	const artefactQuery = useVerificationArtefactById(
		conversationId,
		selectedArtifactId,
	);

	const [isApproving, setIsApproving] = useState(false);
	const [isRevising, setIsRevising] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [editedContent, setEditedContent] = useState<string>("");
	const [isPlaying, setIsPlaying] = useState(false);
	const [localArtefactContent, setLocalArtefactContent] = useState<
		string | null
	>(null);

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const reviseCooldown = useCooldown(30 * 1000); // 30 second cooldown

	const artefactContent =
		localArtefactContent ?? artefactQuery.data?.content ?? "";
	const generatedArtifactId = artefactQuery.data?.id ?? null;
	const readAloudUrl = artefactQuery.data?.read_aloud_stream_url ?? "";
	const artefactDateUpdated = artefactQuery.data?.date_created ?? null;
	const selectedOptionKey = artefactQuery.data?.key ?? null;

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
		// Redirect if artifact_id is missing from URL
		if (!selectedArtifactId) {
			navigate(`/${projectId}/conversation/${conversationId}`, {
				replace: true,
			});
			return;
		}

		// Wait for queries to complete before validating
		if (!artefactQuery.isSuccess || !topicsQuery.isSuccess) {
			return;
		}

		// Redirect if artifact failed to load
		if (!artefactQuery.data) {
			toast.error(t`Unable to load the generated artefact. Please try again.`);
			navigate(`/${projectId}/conversation/${conversationId}`, {
				replace: true,
			});
			return;
		}

		// Redirect if the artifact's key is not in the selected topics
		if (selectedOptionKey && !selectedTopics.includes(selectedOptionKey)) {
			navigate(`/${projectId}/conversation/${conversationId}`, {
				replace: true,
			});
		}
	}, [
		selectedArtifactId,
		selectedOptionKey,
		selectedTopics,
		topicsQuery.isSuccess,
		artefactQuery.isSuccess,
		artefactQuery.data,
		projectId,
		conversationId,
	]);

	const handleApprove = async () => {
		if (!conversationId || !artefactContent || !generatedArtifactId) {
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
		if (!conversationId || !generatedArtifactId) {
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

			reviseCooldown.trigger();

			// Clear local edits since we have fresh content from backend
			setLocalArtefactContent(null);

			// Update the query cache directly with the revised artifact
			queryClient.setQueryData(
				["verify", "artifact_by_id", generatedArtifactId],
				updatedArtefact,
			);

			toast.success(t`Artefact revised successfully!`);
		} catch (error) {
			if (
				error instanceof AxiosError &&
				error?.response?.data.detail.code === "NO_NEW_FEEDBACK"
			) {
				reviseCooldown.trigger();
				toast.info(
					t`No new feedback detected yet. Please continue your discussion and try again soon.`,
				);
			} else {
				toast.error(t`Failed to revise artefact. Please try again.`);
			}
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

	const handleReload = async () => {
		try {
			await Promise.all([
				projectQuery.refetch(),
				topicsQuery.refetch(),
				artefactQuery.refetch(),
			]);
			toast.success(t`Artefact reloaded successfully!`);
		} catch (error) {
			toast.error(t`Failed to reload. Please try again.`);
			console.error("error reloading artefact: ", error);
		}
	};

	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current = null;
			}
		};
	}, []);

	if (projectQuery.isError || topicsQuery.isError || artefactQuery.isError) {
		const isReloading =
			projectQuery.isRefetching ||
			topicsQuery.isRefetching ||
			artefactQuery.isRefetching;

		return (
			<VerifyArtefactError
				onReload={handleReload}
				onGoBack={() =>
					navigate(`/${projectId}/conversation/${conversationId}`, {
						replace: true,
					})
				}
				isReloading={isReloading}
			/>
		);
	}

	const isLoading =
		topicsQuery.isLoading ||
		projectQuery.isLoading ||
		artefactQuery.isLoading ||
		artefactQuery.isFetching;

	if (isLoading && !artefactQuery.data) {
		return <VerifyArtefactLoading />;
	}

	return (
		<Stack gap="lg" className="h-full mt-10">
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
						<Stack gap="md" className="py-4">
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
									<Markdown className="prose-md" content={artefactContent} />
								</div>
							)}
						</Stack>
					)}
				</Paper>
			</ScrollArea>

			<Group
				gap="md"
				className="w-full sticky bottom-[10%] p-4 mx-auto rounded-md shadow-sm border-gray-200 border  bg-white/20 backdrop-blur-sm"
			>
				{isEditing ? (
					<>
						<Button
							size="lg"
							radius="md"
							variant="default"
							className="flex-1 shadow-xl"
							onClick={handleCancelEdit}
						>
							<Trans id="participant.verify.action.button.cancel">Cancel</Trans>
						</Button>
						<Button
							size="lg"
							radius="md"
							className="flex-1 shadow-xl"
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
									reviseCooldown.isOnCooldown ||
									!generatedArtifactId
								}
							>
								{reviseCooldown.isOnCooldown ? (
									<>{reviseCooldown.timeRemainingSeconds}s</>
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
