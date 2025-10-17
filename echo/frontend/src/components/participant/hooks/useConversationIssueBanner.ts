import { t } from "@lingui/core/macro";
import { IconMicrophone, IconVolume, IconVolume3 } from "@tabler/icons-react";

export function useConversationIssueBanner(conversationIssue: string) {
	switch (conversationIssue) {
		case "HIGH_SILENCE":
			return {
				color: "blue" as const,
				icon: IconVolume,
				message: t`We’re picking up some silence. Try speaking up so your voice comes through clearly.`,
				tipLabel: t`Audio Tip`,
			};
		case "HIGH_CROSSTALK":
			return {
				color: "blue" as const,
				icon: IconMicrophone,
				message: t`It sounds like more than one person is speaking. Taking turns will help us hear everyone clearly.`,
				tipLabel: t`Audio Tip`,
			};
		case "HIGH_NOISE":
			return {
				color: "blue" as const,
				icon: IconVolume3,
				message: t`Try moving a bit closer to your microphone for better sound quality.`,
				tipLabel: t`Audio Tip`,
			};
		default:
			return null;
	}
}
