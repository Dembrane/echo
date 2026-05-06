import {
	passwordRequest,
	passwordReset,
	registerUser,
	registerUserVerify,
} from "@directus/sdk";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { ADMIN_BASE_URL, API_BASE_URL } from "@/config";
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
		queryFn: async () => {
			try {
				const response = await fetch(`${API_BASE_URL}/user-settings/me`, {
					credentials: "include",
				});
				if (!response.ok) return null;
				return response.json();
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
			toast.success("Password reset. Log in with your new password.");
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
			toast.success("Check your email for reset instructions.");
			navigate("/check-your-email");
		},
	});
};

export const useVerifyMutation = (doRedirect = true) => {
	const navigate = useI18nNavigate();

	return useMutation({
		mutationFn: async (data: { token: string }) => {
			// 15s ceiling — without it, a hung Directus / proxy would
			// leave the page spinning forever (original infinite-loading bug).
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("Verification timed out. Try again.")),
					15_000,
				),
			);
			try {
				const response = await Promise.race([
					directus.request(registerUserVerify(data.token)),
					timeout,
				]);
				return response;
			} catch (e) {
				throwWithMessage(e);
			}
		},
		// No toast here — the verify page shows the status inline, so a
		// parallel toast is double-signalling. Errors surface via the
		// verifyMutation.isError branch on the page.
		onSuccess: () => {
			if (doRedirect) {
				// Redirect with a "?verified=1" hint so /login can show
				// "Your email is verified. Log in to continue." Shorter
				// delay than before — 1.5s is enough to read the page
				// state before we move the user along.
				setTimeout(() => {
					navigate("/login?verified=1");
				}, 1500);
			}
		},
	});
};

// Probes whether an email is already registered, so Register.tsx can
// block before Directus's anti-enumeration silent-200 traps the user on
// "Check your email" forever. Failures collapse to "available" so an
// outage of the probe never blocks a legit signup.
export const useCheckEmailMutation = () => {
	return useMutation({
		mutationFn: async (
			email: string,
		): Promise<{ status: "available" | "registered" | "invalid" }> => {
			try {
				const res = await fetch(`${API_BASE_URL}/v2/auth/check-email`, {
					body: JSON.stringify({ email }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				});
				if (!res.ok) {
					return { status: "available" };
				}
				return res.json();
			} catch (_e) {
				return { status: "available" };
			}
		},
	});
};

export const useRegisterMutation = () => {
	return useMutation({
		mutationFn: async (payload: Parameters<typeof registerUser>) => {
			try {
				return await directus.request(registerUser(...payload));
			} catch (e) {
				// Map the raw Directus error to a user-facing message, then
				// re-throw so react-query marks the mutation as failed and
				// onError / the inline Alert both fire. Previously only the
				// "no permission" case re-threw; every other failure fell
				// through as undefined and looked like a success, which
				// bounced users to the "Check your email" step even when
				// registration actually failed (e.g. validation errors).
				let mapped: Error = new Error("Registration failed");
				try {
					throwWithMessage(e);
				} catch (inner) {
					if (inner instanceof Error) mapped = inner;
				}
				if (mapped.message === "You don't have permission to access this.") {
					throw new Error(
						"Oops! It seems your email is not eligible for registration at this time. Please consider joining our waitlist for future updates!",
					);
				}
				throw mapped;
			}
		},
		// Success handling lives inline on the Register page — the
		// stepper advances to step 2 ("Check your email"). No toast +
		// no redirect, since the inline state already shows the user
		// exactly what's next. Failures surface via the inline Alert
		// that reads from `registerMutation.error`.
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
	const posthog = usePostHog();

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
			posthog?.capture("user_logged_out");
			posthog?.reset();
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
