import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	LoadingOverlay,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCheck,
	IconMicrophone,
	IconPlus,
	IconReload,
	IconUpload,
} from "@tabler/icons-react";
import clsx from "clsx";
import { useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import {
	useConversationChunksQuery,
	useConversationQuery,
	useParticipantProjectById,
	useUploadConversationTextChunk,
} from "@/components/participant/hooks";
import { ParticipantBody } from "@/components/participant/ParticipantBody";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

export const ParticipantConversationText = () => {
	const { projectId, conversationId } = useParams();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);
	const chunks = useConversationChunksQuery(projectId, conversationId);
	const uploadChunkMutation = useUploadConversationTextChunk();
	const newConversationLink = useProjectSharingLink(projectQuery.data);

	const [text, setText] = useState("");
	const [
		finishModalOpened,
		{ open: openFinishModal, close: closeFinishModal },
	] = useDisclosure(false);

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
	const finishUrl = `/${projectId}/conversation/${conversationId}/finish`;

	const handleConfirmFinishButton = () => {
		navigate(finishUrl);
	};

	if (conversationQuery.isLoading || projectQuery.isLoading) {
		return <LoadingOverlay visible />;
	}

	// Check if conversation is not present or failed to load
	if (conversationQuery.isError || !conversationQuery.data) {
		return (
			<div className="container mx-auto flex h-full max-w-2xl flex-col items-center justify-center">
				<div className="p-8 text-center">
					<Text size="xl" fw={500} c="red" mb="md">
						<Trans id="participant.conversation.error.text.mode">
							Something went wrong
						</Trans>
					</Text>
					<Text size="md" c="dimmed" mb="lg">
						<Trans id="participant.conversation.error.loading.text.mode">
							The conversation could not be loaded. Please try again or contact
							support.
						</Trans>
					</Text>
					<Group justify="center" gap="md">
						<Button
							variant="light"
							size="md"
							onClick={() => window.location.reload()}
							leftSection={<IconReload />}
						>
							<Trans id="participant.button.reload.page.text.mode">
								Reload Page
							</Trans>
						</Button>
						{newConversationLink && (
							<Button
								leftSection={<IconPlus size={16} />}
								variant="filled"
								size="md"
								component="a"
								href={newConversationLink}
							>
								<Trans id="participant.button.start.new.conversation.text.mode">
									Start New Conversation
								</Trans>
							</Button>
						)}
					</Group>
				</div>
			</div>
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
					<Text fw={500}>
						<Trans id="participant.modal.finish.title.text.mode">
							Finish Conversation
						</Trans>
					</Text>
				}
				size="sm"
				radius="md"
				padding="xl"
			>
				<Stack gap="lg">
					<Text>
						<Trans id="participant.modal.finish.message.text.mode">
							Are you sure you want to finish the conversation?
						</Trans>
					</Text>
					<Group grow gap="md">
						<Button
							variant="outline"
							color="gray"
							onClick={closeFinishModal}
							miw={100}
							radius="md"
							size="md"
						>
							<Trans id="participant.button.finish.no.text.mode">No</Trans>
						</Button>
						<Button
							onClick={handleConfirmFinishButton}
							miw={100}
							radius="md"
							size="md"
						>
							<Trans id="participant.button.finish.yes.text.mode">Yes</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Box className={clsx("relative flex-grow px-4 py-12 transition-all")}>
				{projectQuery.data && conversationQuery.data && (
					<ParticipantBody
						viewResponses
						projectId={projectId ?? ""}
						conversationId={conversationId ?? ""}
					/>
				)}

				<div ref={scrollTargetRef} className="h-0" />
			</Box>

			<Stack className="sticky bottom-0 z-10 w-full border-slate-300 bg-white p-4">
				<Group
					justify="center"
					className={"absolute bottom-[110%] left-1/2 z-50 translate-x-[-50%]"}
				>
					{/* <ScrollToBottomButton
            elementRef={scrollTargetRef}
            isVisible={isVisible}
          /> */}
				</Group>
				<textarea
					className="h-32 w-full rounded-md border border-slate-300 p-4"
					placeholder={t`Type your response here`}
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				<Group className="w-full">
					<Button
						size="lg"
						radius="md"
						rightSection={<IconUpload />}
						onClick={onChunk}
						loading={uploadChunkMutation.isPending}
						className="flex-grow"
					>
						<Trans id="participant.button.submit.text.mode">Submit</Trans>
					</Button>

					<I18nLink to={audioModeUrl}>
						<ActionIcon component="a" variant="default" size="50" radius="md">
							<IconMicrophone />
						</ActionIcon>
					</I18nLink>
					{text.trim() === "" && chunks.data && chunks.data.length > 0 && (
						<Button
							size="lg"
							radius="md"
							onClick={openFinishModal}
							variant="light"
							rightSection={<IconCheck />}
						>
							<Trans id="participant.button.finish.text.mode">Finish</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</div>
	);
};
