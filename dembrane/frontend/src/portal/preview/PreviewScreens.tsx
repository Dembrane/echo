import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack } from "@mantine/core";
import { ArticleNyTimesIcon, MicrophoneIcon } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import type { PreviewResult } from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";
import { ParticipantEchoMessages } from "../components/conversation/audio/ParticipantEchoMessages";
import { ConversationMessages } from "../components/conversation/ConversationMessages";
import { RefineButtonLabel } from "../components/refine/RefineButtonLabel";
import { RefineSelection } from "../components/refine/RefineSelection";
import { refineMode } from "../components/refine/refineMode";
import { useRefineActions } from "../components/refine/useRefineActions";
import ParticipantOnboardingCards from "../components/start/ParticipantOnboardingCards";
import { VerifyArtefact } from "../components/verify/VerifyArtefact";
import { VerifySelection } from "../components/verify/VerifySelection";
import { useParticipantProjectById } from "../hooks";
import { ParticipantPostConversation } from "../routes/ParticipantPostConversation";
import { PREVIEW_CONVERSATION_ID } from "./fixtures";
import { scrollParent } from "./PreviewHighlight";

/** The Explore reply the recording screen shows: the dashboard's example or a tried result. */
export const ExploreReplyContext = createContext<PreviewResult | null>(null);

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
 * which would ask for the microphone and start its liveness ping: Record records nothing.
 * Its Verify or Explore button goes where the live one goes (ECHO-1062), through the same
 * actions; with ?echo=1 the screen shows an Explore reply, as the live one does.
 */
export const RecordingScreen = () => {
	const { project, projectId } = useProject();
	const { conversationId } = useParams();
	const [searchParams] = useSearchParams();
	const refine = useRefineActions({
		aiUnavailable: project?.is_ai_available === false,
		conversationId,
		projectId,
	});
	const navigate = useI18nNavigate();
	if (!project || !projectId) return null;
	const mode = refineMode(project);
	const onRefine = () => {
		if (mode === "verify" && refine.goVerify()) return;
		if (mode === "explore" && refine.goExplore()) return;
		navigate(`/${projectId}/conversation/${conversationId}/refine`);
	};
	return (
		<Box className="flex h-full flex-col">
			<Box className="relative flex-grow p-4">
				<ConversationMessages
					interleaveMessages={false}
					projectId={projectId}
					conversationId={PREVIEW_CONVERSATION_ID}
					isAnonymized={project.anonymize_transcripts ?? false}
				/>
				{searchParams.get("echo") === "1" && <ExploreReply />}
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
						<Button
							size="lg"
							data-mode={mode}
							onClick={onRefine}
							{...testId("portal-preview-refine-button")}
						>
							<RefineButtonLabel mode={mode} />
						</Button>
					)}
				</Group>
			</Stack>
		</Box>
	);
};

/** An Explore reply under the conversation: the dashboard's example or a tried result. */
const ExploreReply = () => {
	const text = useContext(ExploreReplyContext)?.text ?? "";
	const end = useRef<HTMLDivElement>(null);
	// The reply comes in under the conversation; show it, as the live screen scrolls to it.
	useEffect(() => {
		const el = end.current;
		const box = el ? scrollParent(el) : null;
		if (box) box.scrollTop = box.scrollHeight;
	}, []);
	return (
		<>
			<ParticipantEchoMessages
				echoMessages={[
					{ content: "", id: "1", role: "user" },
					{ content: text, id: "2", role: "assistant" },
				]}
				isLoading={false}
				status="ready"
				error={undefined}
			/>
			<div ref={end} />
		</>
	);
};

/** The choice between Verify and Explore, when both are on. */
export const RefineScreen = () => (
	<Box className="h-full px-4">
		<RefineSelection />
	</Box>
);

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
