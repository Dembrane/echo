import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack } from "@mantine/core";
import { ArticleNyTimesIcon, MicrophoneIcon } from "@phosphor-icons/react";
import { createContext, useContext } from "react";
import { useParams } from "react-router";
import type { PreviewResult } from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";
import { ParticipantEchoMessages } from "../components/conversation/audio/ParticipantEchoMessages";
import { ConversationMessages } from "../components/conversation/ConversationMessages";
import { RefineButtonLabel } from "../components/refine/RefineButtonLabel";
import { refineMode } from "../components/refine/refineMode";
import ParticipantOnboardingCards from "../components/start/ParticipantOnboardingCards";
import { VerifyArtefact } from "../components/verify/VerifyArtefact";
import { VerifySelection } from "../components/verify/VerifySelection";
import { useParticipantProjectById } from "../hooks";
import { ParticipantPostConversation } from "../routes/ParticipantPostConversation";
import { PREVIEW_CONVERSATION_ID } from "./fixtures";

/**
 * The result the Explore screen shows: the dashboard's hand-written example today, a real
 * model result once ECHO-1061 sends one in the same message field.
 */
export const PreviewResultContext = createContext<PreviewResult | null>(null);

const useProject = () => {
	const { projectId } = useParams();
	return {
		project: useParticipantProjectById(projectId ?? "").data,
		projectId,
	};
};

/** The start screen's cards, opened on the first card, the privacy card or the form. */
export const OnboardingScreen = ({
	card,
}: {
	card: "first" | "privacy" | "last";
}) => {
	const { project } = useProject();
	if (!project) return null;
	return (
		<div className="h-full grow">
			<ParticipantOnboardingCards
				key={card}
				project={project}
				initialSlide={card}
			/>
		</div>
	);
};

/**
 * The recording screen before the first press of Record: its real conversation column,
 * and the bar under it as it stands then. The bar is drawn here, not by the recorder,
 * which would ask for the microphone and start its liveness ping.
 */
export const RecordingScreen = ({
	children,
}: {
	children?: React.ReactNode;
}) => {
	const { project, projectId } = useProject();
	if (!project || !projectId) return null;
	const mode = refineMode(project);
	return (
		<Box className="flex h-full flex-col">
			<Box className="relative flex-grow p-4">
				<ConversationMessages
					interleaveMessages={false}
					projectId={projectId}
					conversationId={PREVIEW_CONVERSATION_ID}
					isAnonymized={project.anonymize_transcripts ?? false}
				/>
				{children}
			</Box>
			<Stack
				bg="var(--app-background)"
				gap="lg"
				className="sticky bottom-0 z-10 w-full border-t p-4"
				style={{ borderColor: "var(--app-rule-color)" }}
				{...testId("portal-preview-recording-bar")}
			>
				<Group className="w-full" wrap="nowrap">
					<Button
						size="lg"
						variant="filled"
						leftSection={<MicrophoneIcon size={20} />}
						className="flex-grow"
					>
						<Trans id="participant.button.record">Record</Trans>
					</Button>
					<Button size="lg" px="lg" aria-label={t`Switch to text`}>
						<ArticleNyTimesIcon size={20} />
					</Button>
					{mode && (
						<Button size="lg" data-mode={mode}>
							<RefineButtonLabel mode={mode} />
						</Button>
					)}
				</Group>
			</Stack>
		</Box>
	);
};

/** The recording screen with an Explore reply under the conversation. */
export const ExploreScreen = () => {
	const text = useContext(PreviewResultContext)?.text ?? "";
	return (
		<RecordingScreen>
			<ParticipantEchoMessages
				echoMessages={[
					{ content: "", id: "1", role: "user" },
					{ content: text, id: "2", role: "assistant" },
				]}
				isLoading={false}
				status="ready"
				error={undefined}
			/>
		</RecordingScreen>
	);
};

export const VerifyTopicsScreen = () => (
	<Box className="h-full px-4">
		<VerifySelection />
	</Box>
);

export const VerifySummaryScreen = () => (
	<Box className="h-full px-4">
		<VerifyArtefact />
	</Box>
);

export const FinishScreen = () => <ParticipantPostConversation />;
