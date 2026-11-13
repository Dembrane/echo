import { t } from "@lingui/core/macro";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { initiateConversation } from "@/lib/api";
import { portalRecordingRefusal } from "@/lib/freeTier";

export const useInitiateConversationMutation = () => {
	return useMutation({
		mutationFn: initiateConversation,
		onError: (error) => {
			// The form shows a refusal itself.
			if (portalRecordingRefusal(error)) return;
			toast.error(t`Invalid PIN or email. Please try again.`);
		},
	});
};
