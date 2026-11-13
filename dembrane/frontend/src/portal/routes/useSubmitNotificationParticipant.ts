import { useMutation } from "@tanstack/react-query";
import { submitNotificationParticipant } from "@/lib/api";

export const useSubmitNotificationParticipant = () => {
	return useMutation({
		mutationFn: async ({
			emails,
			projectId,
			conversationId,
		}: {
			emails: string[];
			projectId: string;
			conversationId: string;
		}) => {
			return await submitNotificationParticipant(
				emails,
				projectId,
				conversationId,
			);
		},
		onError: (error) => {
			console.error("Notification submission failed:", error);
		},
		retry: 2,
	});
};
