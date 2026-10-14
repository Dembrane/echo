import { t } from "@lingui/core/macro";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { initiateConversation } from "@/lib/api";

export const useInitiateConversationMutation = () => {
	return useMutation({
		mutationFn: initiateConversation,
		onError: () => {
			toast.error(t`Invalid PIN or email. Please try again.`);
		},
	});
};
