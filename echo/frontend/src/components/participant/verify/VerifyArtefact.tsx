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
import { memo, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Logo } from "../../common/Logo";
import { Markdown } from "../../common/Markdown";
import { MarkdownWYSIWYG } from "../../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import {
	useGenerateVerificationArtefact,
	useSaveVerificationArtefact,
} from "./hooks";
import { VerifyInstructions } from "./VerifyInstructions";
import { VERIFY_OPTIONS } from "./VerifySelection";

const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

export const VerifyArtefact = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();
	const saveArtefactMutation = useSaveVerificationArtefact();
	const generateArtefactMutation = useGenerateVerificationArtefact();

	// Get selected option from URL params
	const selectedOptionKey = searchParams.get("key");

	// States
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

	// Ref for audio element
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const reviseTimerRef = useRef<NodeJS.Timeout | null>(null);

	const selectedOption = VERIFY_OPTIONS.find(
		(opt) => opt.key === selectedOptionKey,
	);
	const selectedOptionLabel = selectedOption?.label || t`verified`;

	// Redirect back if no selected option key
	useEffect(() => {
		if (!selectedOptionKey) {
			navigate(`/${projectId}/conversation/${conversationId}/verify`, {
				replace: true,
			});
		}
	}, [selectedOptionKey, navigate, projectId, conversationId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: we want to regenerate the artefact if the user clicks the next button
	useEffect(() => {
		if (!selectedOptionKey || !conversationId || hasGenerated) return;

		const generateArtefact = async () => {
			try {
				setHasGenerated(true);
				const response = await generateArtefactMutation.mutateAsync({
					conversationId,
					topicList: [selectedOptionKey], // only one for now
				});

				// Get the first artifact from the response
				if (response && response.length > 0) {
					const artifact = response[0];
					setArtefactContent(artifact.content);
					// Set read aloud URL from API response
					setReadAloudUrl(artifact.read_aloud_stream_url || "");
				}
			} catch (error) {
				console.error("Failed to generate artifact:", error);
				setHasGenerated(false); // Reset on error so user can retry
			}
		};

		generateArtefact();
	}, [selectedOptionKey, conversationId, hasGenerated]);

	const handleNextFromInstructions = () => {
		setShowInstructions(false);
	};

	const handleApprove = async () => {
		if (!conversationId || !selectedOptionKey || !artefactContent) return;

		setIsApproving(true);
		try {
			await saveArtefactMutation.mutateAsync({
				artefactContent,
				conversationId,
				key: selectedOptionKey,
			});

			// Navigate back to conversation
			const conversationUrl = `/${projectId}/conversation/${conversationId}`;
			navigate(conversationUrl);
		} finally {
			setIsApproving(false);
		}
	};

	const handleRevise = async () => {
		if (!conversationId || !selectedOptionKey) return;
		setIsRevising(true);
		try {
			// Mock API call to revise artefact (3 seconds)
			await new Promise((resolve) => setTimeout(resolve, 3000));

			const response = await generateArtefactMutation.mutateAsync({
				conversationId: conversationId,
				topicList: [selectedOptionKey], // only one for now
			});

			// Get the first artifact from the response
			if (response && response.length > 0) {
				const artifact = response[0];
				setArtefactContent(artifact.content);
				// Set read aloud URL from API response
				setReadAloudUrl(artifact.read_aloud_stream_url || "");
			}
			setLastReviseTime(Date.now()); // Start cooldown timer
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
		if (!editedContent) return;

		// Update the artefact content with edited content
		setArtefactContent(editedContent);
		// Exit edit mode to show Revise/Approve buttons
		setIsEditing(false);
		setEditedContent("");
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

	// Cooldown timer for revise button (2 minutes)
	useEffect(() => {
		if (lastReviseTime === null) return;

		const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes in milliseconds

		const updateTimer = () => {
			const now = Date.now();
			const elapsed = now - lastReviseTime;
			const remaining = Math.max(0, COOLDOWN_MS - elapsed);

			setReviseTimeRemaining(remaining);

			if (remaining === 0) {
				if (reviseTimerRef.current) {
					clearInterval(reviseTimerRef.current);
					reviseTimerRef.current = null;
				}
			}
		};

		// Update immediately
		updateTimer();

		// Update every second
		reviseTimerRef.current = setInterval(updateTimer, 1000);

		return () => {
			if (reviseTimerRef.current) {
				clearInterval(reviseTimerRef.current);
				reviseTimerRef.current = null;
			}
		};
	}, [lastReviseTime]);

	// Cleanup audio on unmount
	useEffect(() => {
		return () => {
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current = null;
			}
		};
	}, []);

	// step 1: show instructions while generating response from api
	if (showInstructions) {
		return (
			<VerifyInstructions
				objectLabel={selectedOptionLabel}
				isLoading={generateArtefactMutation.isPending}
				onNext={handleNextFromInstructions}
			/>
		);
	}

	// step 2: show artefact with revise/approve once user clicks next on step 1
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
										This would just take a few moments
									</Trans>
								</Text>
							</Stack>
						</Stack>
					) : (
						<Stack gap="md">
							{/* Title with Read Aloud Button */}
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

							{/* Markdown Content or Editor */}
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

			{/* Action buttons */}
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
								disabled={isRevising || isApproving || reviseTimeRemaining > 0}
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
								disabled={isRevising || isApproving}
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
							disabled={isApproving || isRevising}
						>
							<Trans id="participant.verify.action.button.aprrove">
								Approve
							</Trans>
						</Button>
					</>
				)}
			</Group>
		</Stack>
	);
};
