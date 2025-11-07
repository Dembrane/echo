import type { Message } from "@ai-sdk/react";
import { useOutletContext, useParams } from "react-router";
import { useConversationQuery, useParticipantProjectById } from "./hooks";
import { ParticipantBody } from "./ParticipantBody";
import { ParticipantEchoMessages } from "./ParticipantEchoMessages";
import { VerifiedArtefactsList } from "./verify/VerifiedArtefactsList";

type OutletContextType = {
	isRecording: boolean;
	echoMessages: Message[];
	echoIsLoading: boolean;
	echoStatus: string;
	echoError: Error | undefined;
};

export const ParticipantConversationAudioContent = () => {
	const { projectId, conversationId } = useParams();
	const { isRecording, echoMessages, echoIsLoading, echoStatus, echoError } =
		useOutletContext<OutletContextType>();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);

	return (
		<>
			{projectQuery.data && conversationQuery.data && (
				<ParticipantBody
					interleaveMessages={false}
					projectId={projectId ?? ""}
					conversationId={conversationId ?? ""}
					isRecording={isRecording}
				/>
			)}

			<VerifiedArtefactsList conversationId={conversationId ?? ""} />

			<ParticipantEchoMessages
				echoMessages={echoMessages}
				isLoading={echoIsLoading}
				status={echoStatus}
				error={echoError}
			/>
		</>
	);
};
