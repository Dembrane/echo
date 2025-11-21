import {
	passwordRequest,
	passwordReset,
	readUser,
	registerUser,
	registerUserVerify,
} from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { ADMIN_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { directus } from "@/lib/directus";
import { throwWithMessage } from "../utils/errorUtils";

export const useCurrentUser = ({
	enabled = true,
}: {
	enabled?: boolean;
} = {}) =>
	useQuery({
		enabled,
		queryFn: () => {
			try {
				return directus.request(
					readUser("me", {
						fields: [
							"id",
							"first_name",
							"email",
							"disable_create_project",
							"tfa_secret",
						],
					}),
				);
			} catch (_error) {
				return null;
			}
		},
		queryKey: ["users", "me"],
	});

export const useResetPasswordMutation = () => {
	const navigate = useI18nNavigate();
	return useMutation({
		mutationFn: async ({
			token,
			password,
		}: {
			token: string;
			password: string;
		}) => {
			try {
				const response = await directus.request(passwordReset(token, password));
				return response;
			} catch (e) {
				throwWithMessage(e);
			}
		},
		onError: (e) => {
			try {
				toast.error(e.message);
			} catch (_e) {
				toast.error("Error resetting password. Please contact support.");
			}
		},
		onSuccess: () => {
			toast.success(
				"Password reset successfully. Please login with new password.",
			);
			navigate("/login");
		},
	});
};

export const useRequestPasswordResetMutation = () => {
	const navigate = useI18nNavigate();
	return useMutation({
		mutationFn: async (email: string) => {
			try {
				const response = await directus.request(
					passwordRequest(email, `${ADMIN_BASE_URL}/password-reset`),
				);
				return response;
			} catch (e) {
				throwWithMessage(e);
			}
		},
		onError: (e) => {
			toast.error(e.message);
		},
		onSuccess: () => {
			toast.success("Password reset email sent successfully");
			navigate("/check-your-email");
		},
	});
};

export const useVerifyMutation = (doRedirect = true) => {
	const navigate = useI18nNavigate();

	return useMutation({
		mutationFn: async (data: { token: string }) => {
			try {
				const response = await directus.request(registerUserVerify(data.token));
				return response;
			} catch (e) {
				throwWithMessage(e);
			}
		},
		onError: (e) => {
			toast.error(e.message);
		},
		onSuccess: () => {
			toast.success("Email verified successfully.");
			if (doRedirect) {
				setTimeout(() => {
					// window.location.href = `/login?new=true`;
					navigate("/login?new=true");
				}, 4500);
			}
		},
	});
};

export const useRegisterMutation = () => {
	const navigate = useI18nNavigate();
	return useMutation({
		mutationFn: async (payload: Parameters<typeof registerUser>) => {
			try {
				const response = await directus.request(registerUser(...payload));
				return response;
			} catch (e) {
				try {
					throwWithMessage(e);
				} catch (inner) {
					if (inner instanceof Error) {
						if (inner.message === "You don't have permission to access this.") {
							throw new Error(
								"Oops! It seems your email is not eligible for registration at this time. Please consider joining our waitlist for future updates!",
							);
						}
					}
				}
			}
		},
		onError: (e) => {
			toast.error(e.message);
		},
		onSuccess: () => {
			toast.success("Please check your email to verify your account.");
			navigate("/check-your-email");
		},
	});
};

// todo: add redirection logic here
export const useLoginMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			email,
			password,
			otp,
		}: {
			email: string;
			password: string;
			otp?: string;
		}) => {
			return directus.login(
				{ email, password },
				{
					otp: otp || undefined,
				},
			);
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["auth", "session"] }),
				queryClient.invalidateQueries({ queryKey: ["users", "me"] }),
			]);
		},
	});
};

export const useLogoutMutation = () => {
	const queryClient = useQueryClient();
	const navigate = useI18nNavigate();

	return useMutation({
		mutationFn: async ({
			next: _,
		}: {
			next?: string;
			reason?: string;
			doRedirect: boolean;
		}) => {
			try {
				await directus.logout();
			} catch (e) {
				const status = (e as { response?: { status?: number } })?.response
					?.status;
				if (status === 401 || status === 403) {
					return;
				}
				throwWithMessage(e);
			}
		},
		onError: (_error, { next, reason, doRedirect }) => {
			if (doRedirect) {
				navigate(
					"/login" +
						(next ? `?next=${encodeURIComponent(next)}` : "") +
						(reason ? `&reason=${reason}` : ""),
				);
			}
		},
		onMutate: async () => {
			await queryClient.cancelQueries();
			queryClient.setQueryData(["auth", "session"], false);
			queryClient.removeQueries({ exact: false, queryKey: ["users", "me"] });
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
		},
		onSuccess: (_data, { next, reason, doRedirect }) => {
			if (doRedirect) {
				navigate(
					"/login" +
						(next ? `?next=${encodeURIComponent(next)}` : "") +
						(reason ? `&reason=${reason}` : ""),
				);
			}
		},
	});
};

export const useAuthenticated = (doRedirect = false) => {
	const logoutMutation = useLogoutMutation();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const hasLoggedOutRef = useRef(false);

	const sessionQuery = useQuery({
		queryFn: async () => {
			await directus.refresh();
			return true as const;
		},
		queryKey: ["auth", "session"],
		retry: false,
		staleTime: 60_000,
	});

	useEffect(() => {
		if (sessionQuery.isError && doRedirect && !hasLoggedOutRef.current) {
			hasLoggedOutRef.current = true;
			logoutMutation.mutate({
				doRedirect,
				next: location.pathname,
				reason: searchParams.get("reason") ?? "",
			});
		}
	}, [
		doRedirect,
		location.pathname,
		logoutMutation,
		searchParams,
		sessionQuery.isError,
	]);

	return {
		isAuthenticated: sessionQuery.data === true,
		loading: sessionQuery.isLoading,
	};
};
