import { t } from "@lingui/core/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { throwWithMessage } from "@/components/auth/utils/errorUtils";
import { toast } from "@/components/common/Toaster";
import { directus } from "@/lib/directus";

export * from "./useAuditLogsQuery";

export interface GenerateTwoFactorResponse {
	secret: string;
	otpauth_url: string;
}

const postDirectus = async <TResponse>(
	path: string,
	body: Record<string, unknown>,
) => {
	try {
		return await directus.request<TResponse>(() => ({
			body: JSON.stringify(body),
			method: "POST",
			path,
		}));
	} catch (error) {
		throwWithMessage(error);
	}
};

export const useGenerateTwoFactorMutation = () => {
	return useMutation({
		mutationFn: async ({ password }: { password: string }) => {
			const data = await postDirectus<GenerateTwoFactorResponse>(
				"/users/me/tfa/generate",
				{ password },
			);

			return data;
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});
};

export const useEnableTwoFactorMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ otp, secret }: { otp: string; secret: string }) => {
			await postDirectus("/users/me/tfa/enable", { otp, secret });
		},
		onError: (error: Error) => {
			if (error.message.includes('Invalid payload. "otp" is invalid')) {
				toast.error(t`The code didn't work, please try again.`);
			} else {
				toast.error(error.message);
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["users", "me"],
			});
			toast.success(t`Two-factor authentication enabled`);
		},
	});
};

export const useDisableTwoFactorMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ otp }: { otp: string }) => {
			await postDirectus("/users/me/tfa/disable", { otp });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["users", "me"],
			});
			toast.success(t`Two-factor authentication disabled`);
		},
	});
};
