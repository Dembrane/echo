import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	CheckIcon,
	MicrophoneIcon,
	UploadSimpleIcon,
} from "@phosphor-icons/react";
import clsx from "clsx";
import posthog from "posthog-js";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import {
	useConversationChunksQuery,
	useConversationQuery,
	useParticipantProjectById,
	useUploadConversationTextChunk,
} from "@/components/participant/hooks";
import { ConversationErrorView } from "@/components/participant/ConversationErrorView";
import { ParticipantBody } from "@/components/participant/ParticipantBody";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { finishConversation } from "@/lib/api";
import { testId } from "@/lib/testUtils";

export const ParticipantConversationText = () => {
	const { projectId, conversationId } = useParams();
	const [searchParams] = useSearchParams();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);
	const chunks = useConversationChunksQuery(projectId, conversationId);
	const uploadChunkMutation = useUploadConversationTextChunk();
	const newConversationLink = useProjectSharingLink(
		projectQuery.data,
		"portal",
	);

	const [text, setText] = useState(() => {
		return (
			searchParams.get("general_feedback") || searchParams.get("feedback") || ""
		);
	});
	const [
		finishModalOpened,
		{ open: openFinishModal, close: closeFinishModal },
	] = useDisclosure(false);
	const [isStopping, setIsStopping] = useState(false);

	const [scrollTargetRef] = useElementOnScreen({
		root: null,
		rootMargin: "-158px",
		threshold: 0.1,
	});

	const onChunk = () => {
		if (!text || text.trim() === "") {
			return;
		}

		setTimeout(() => {
			if (scrollTargetRef.current) {
				scrollTargetRef.current.scrollIntoView({ behavior: "smooth" });
			}
		}, 0);

		uploadChunkMutation.mutate({
			content: text.trim(),
			conversationId: conversationId ?? "",
			source: "PORTAL_TEXT",
			timestamp: new Date(),
		});

		setText("");
	};

	const navigate = useI18nNavigate();

	const audioModeUrl = `/${projectId}/conversation/${conversationId}`;
	const currentSearch = searchParams.toString();
	const finishUrl = `/${projectId}/conversation/${conversationId}/finish${currentSearch ? `?${currentSearch}` : ""}`;

	const handleConfirmFinishButton = async () => {
		setIsStopping(true);
		try {
			await finishConversation(conversationId ?? "");
			posthog.capture("conversation_finished", {
				conversation_id: conversationId,
				project_id: projectId,
			});
			closeFinishModal();
			navigate(finishUrl);
		} catch (error) {
			console.error("Error finishing conversation:", error);
			toast.error(t`Failed to finish conversation. Please try again.`);
			setIsStopping(false);
		}
	};

	if (conversationQuery.isLoading || projectQuery.isLoading) {
		return <BeautifulLoading quiet className="min-h-dvh" />;
	}

	// Check if conversation is not present or failed to load
	if (conversationQuery.isError || !conversationQuery.data) {
		return (
			<ConversationErrorView
				conversationDeletedDuringRecording={false}
				newConversationLink={newConversationLink}
			/>
		);
	}

	return (
		<div className="container mx-auto flex h-full max-w-2xl flex-col">
			{/* modal for finish conversation confirmation */}
			<Modal
				opened={finishModalOpened}
				onClose={closeFinishModal}
				centered
				title={
					<Trans id="participant.modal.finish.title.text.mode">
						Finish conversation
					</Trans>
				}
				size="sm"
				padding="xl"
				{...testId("portal-text-finish-modal")}
			>
				<Stack gap="lg">
					<Text>
						<Trans id="participant.modal.finish.message.text.mode">
							Are you sure you want to finish the conversation?
						</Trans>
					</Text>
					<Group gap="sm">
						<Button
							variant="filled"
							onClick={handleConfirmFinishButton}
							loading={isStopping}
							miw={100}
							size="md"
							{...testId("portal-text-finish-confirm-button")}
						>
							<Trans id="participant.button.finish.confirm.text.mode">
								Finish
							</Trans>
						</Button>
						<Button
							variant="subtle"
							color="gray"
							onClick={closeFinishModal}
							disabled={isStopping}
							miw={100}
							size="md"
							{...testId("portal-text-finish-cancel-button")}
						>
							<Trans id="participant.button.finish.cancel.text.mode">
								Cancel
							</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Box
				className={clsx("relative flex-grow px-4 pt-4 pb-12 transition-all")}
			>
				{projectQuery.data && conversationQuery.data && (
					<ParticipantBody
						viewResponses
						projectId={projectId ?? ""}
						conversationId={conversationId ?? ""}
						isAnonymized={conversationQuery.data?.is_anonymized ?? false}
						mode="text"
					/>
				)}

				<div ref={scrollTargetRef} className="h-0" />
			</Box>

			<Stack
				bg="var(--app-background)"
				className="sticky bottom-0 z-10 w-full border-t p-4"
				style={{ borderColor: "var(--app-rule-color)" }}
			>
				<Group
					justify="center"
					className={"absolute bottom-[110%] left-1/2 z-50 translate-x-[-50%]"}
				>
					{/* <ScrollToBottomButton
            elementRef={scrollTargetRef}
            isVisible={isVisible}
          /> */}
				</Group>
				<Textarea
					minRows={4}
					autosize
					maxRows={10}
					placeholder={t`Type your response here`}
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
					{...testId("portal-text-input-textarea")}
				/>
				<Group className="w-full">
					<Button
						size="lg"
						variant="filled"
						leftSection={<UploadSimpleIcon size={20} />}
						onClick={onChunk}
						loading={uploadChunkMutation.isPending}
						className="flex-grow"
						{...testId("portal-text-submit-button")}
					>
						<Trans id="participant.button.submit.text.mode">Submit</Trans>
					</Button>

					<I18nLink to={audioModeUrl}>
						<Button
							size="lg"
							px="lg"
							aria-label={t`Switch to audio`}
							{...testId("portal-text-switch-to-audio-button")}
						>
							<MicrophoneIcon size={20} />
						</Button>
					</I18nLink>
					{text.trim() === "" && chunks.data && chunks.data.length > 0 && (
						<Button
							size="lg"
							onClick={openFinishModal}
							leftSection={<CheckIcon size={20} />}
							{...testId("portal-text-finish-button")}
						>
							<Trans id="participant.button.finish.text.mode">Finish</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</div>
	);
};
