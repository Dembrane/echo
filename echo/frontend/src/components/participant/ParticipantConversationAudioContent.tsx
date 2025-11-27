import { useChat } from "@ai-sdk/react";
import { useEffect, useRef } from "react";
import { useOutletContext, useParams, useSearchParams } from "react-router";
import { API_BASE_URL } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import {
	useConversationQuery,
	useConversationRepliesQuery,
	useParticipantProjectById,
} from "./hooks";
import { ParticipantBody } from "./ParticipantBody";
import { ParticipantEchoMessages } from "./ParticipantEchoMessages";
import { VerifiedArtefactsList } from "./verify/VerifiedArtefactsList";

type OutletContextType = {
	isRecording: boolean;
};

export const ParticipantConversationAudioContent = () => {
	const echoRef = useRef(false);
	const scrollTargetRef = useRef<HTMLDivElement>(null);
	const { iso639_1 } = useLanguage();

	const { projectId, conversationId } = useParams();
	const [searchParams, setSearchParams] = useSearchParams();
	const { isRecording } = useOutletContext<OutletContextType>();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);

	const hasEchoParam = searchParams.get("echo") === "1";

	const repliesQuery = useConversationRepliesQuery(conversationId);

	const {
		messages: echoMessages,
		isLoading: echoIsLoading,
		status: echoStatus,
		error: echoError,
		handleSubmit,
	} = useChat({
		api: `${API_BASE_URL}/conversations/${conversationId}/get-reply`,
		body: { language: iso639_1 },
		experimental_prepareRequestBody() {
			return {
				language: iso639_1,
			};
		},
		initialMessages:
			repliesQuery.data?.map((msg) => ({
				content: msg.content_text ?? "",
				id: String(msg.id),
				role: msg.type === "assistant_reply" ? "assistant" : "user",
			})) ?? [],
		onError: (error) => {
			console.error("onError", error);
		},
	});
	const handleReply = async (e: React.MouseEvent<HTMLButtonElement>) => {
		try {
			setTimeout(() => {
				if (scrollTargetRef.current) {
					scrollTargetRef.current.scrollIntoView({ behavior: "smooth" });
				}
			}, 0);
			handleSubmit(e, { allowEmptySubmit: true });
		} catch (error) {
			console.error("Error during echo:", error);
		}
	};
	// end

	// biome-ignore lint/correctness/useExhaustiveDependencies: just need to run it once on page landing
	useEffect(() => {
		if (hasEchoParam && !echoRef.current) {
			echoRef.current = true;
			setTimeout(() => {
				const syntheticEvent = new MouseEvent(
					"click",
				) as unknown as React.MouseEvent<HTMLButtonElement>;

				handleReply(syntheticEvent);
			}, 100);
			// Remove the echo parameter from URL
			const newSearchParams = new URLSearchParams(searchParams);
			newSearchParams.delete("echo");
			setSearchParams(newSearchParams, { replace: true });
		}
	}, []);

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

			<VerifiedArtefactsList
				conversationId={conversationId ?? ""}
				projectId={projectId ?? ""}
				projectLanguage={projectQuery.data?.language}
			/>

			<ParticipantEchoMessages
				echoMessages={echoMessages}
				isLoading={echoIsLoading}
				status={echoStatus}
				error={echoError}
			/>

			<div ref={scrollTargetRef} />
		</>
	);
};
