import { t } from "@lingui/core/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { ApiRequestError, errorCode } from "@/lib/errors/read";

export * from "./useAuditLogsQuery";

export interface GenerateTwoFactorResponse {
	secret: string;
	otpauth_url: string;
}

const postApi = async <TResponse>(
	path: string,
	body: Record<string, unknown>,
): Promise<TResponse> => {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		body: JSON.stringify(body),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new ApiRequestError(response.status, data);
	}

	// Some endpoints return 204 No Content
	const text = await response.text();
	return text ? JSON.parse(text) : ({} as TResponse);
};

export const useGenerateTwoFactorMutation = () => {
	return useMutation({
		mutationFn: async ({ password }: { password: string }) => {
			return postApi<GenerateTwoFactorResponse>("/user-settings/tfa/generate", {
				password,
			});
		},
		onError: (error: Error) => {
			void notifyError(error);
		},
	});
};

// The platform sends account.otp_invalid; the text check covers the Python API until cutover.
const isOtpInvalid = (error: Error) =>
	errorCode(error) === "account.otp_invalid" ||
	error.message.includes('Invalid payload. "otp" is invalid');

export const useEnableTwoFactorMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ otp, secret }: { otp: string; secret: string }) => {
			await postApi("/user-settings/tfa/enable", { otp, secret });
		},
		onError: (error: Error) => {
			if (isOtpInvalid(error)) {
				toast.error(t`The code didn't work, please try again.`);
			} else {
				void notifyError(error);
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
			await postApi("/user-settings/tfa/disable", { otp });
		},
		onError: (error: Error) => {
			if (isOtpInvalid(error)) {
				toast.error(t`The code didn't work, please try again.`);
			} else {
				void notifyError(error);
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["users", "me"],
			});
			toast.success(t`Two-factor authentication disabled`);
		},
	});
};
