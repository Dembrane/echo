import type { Message } from "@ai-sdk/react";
import { t } from "@lingui/core/macro";
import { Stack } from "@mantine/core";
import { testId } from "@/lib/testUtils";
import { EchoErrorAlert } from "./EchoErrorAlert";
import SpikeMessage from "./SpikeMessage";

type ParticipantEchoMessagesProps = {
	echoMessages: Message[];
	isLoading: boolean;
	status: string;
	error: Error | undefined;
};

export const ParticipantEchoMessages = ({
	echoMessages,
	isLoading,
	status,
	error,
}: ParticipantEchoMessagesProps) => {
	return (
		<Stack gap="sm" {...testId("portal-explore-messages-container")}>
			{echoMessages && echoMessages.length > 0 && (
				<>
					{echoMessages.map((message, index) => (
						<SpikeMessage
							key={message.id}
							message={{
								content_text: message.content,
								date_created: new Date().toISOString(),
								// @ts-expect-error - id is a string
								id: Number.parseInt(message.id, 10) || 0,
								type: message.role === "assistant" ? "assistant_reply" : "user",
							}}
							loading={index === echoMessages.length - 1 && isLoading}
							className={`min-h-[180px] md:min-h-[169px] ${index !== echoMessages.length - 1 ? "border-b" : ""}`}
							dataTestId={`portal-explore-message-${index}`}
						/>
					))}
					{status !== "streaming" && status !== "ready" && !error && (
						<SpikeMessage
							key="thinking"
							message={{
								content_text: t`Thinking...`,
								date_created: new Date().toISOString(),
								// @ts-expect-error - id is a string
								id: 0,
								type: "assistant_reply",
							}}
							loading={true}
							className="min-h-[180px] md:min-h-[169px]"
							dataTestId="portal-explore-thinking"
						/>
					)}
				</>
			)}

			{error && <EchoErrorAlert error={error} />}
		</Stack>
	);
};
