import { Trans } from "@lingui/react/macro";
import { Text, type TextProps } from "@mantine/core";
import { errorCode } from "@/lib/errors/read";

const CODE = "portal.ai_unavailable";

/** The portal's refusal of Verify or Explore, from axios or a useChat stream. */
export const isAiUnavailableError = (err: unknown): boolean => {
	if (errorCode(err) === CODE) return true;
	if (!(err instanceof Error)) return false;
	// useChat throws the refused response's body text as the message.
	try {
		return JSON.parse(err.message)?.code === CODE;
	} catch {
		return false;
	}
};

export const AiUnavailableText = (props: TextProps) => (
	<Text size="sm" c="dimmed" {...props}>
		<Trans id="participant.ai_unavailable">Not available right now</Trans>
	</Text>
);
