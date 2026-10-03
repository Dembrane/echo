import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { resetPromptSeen } from "@/features/accounts/help/tasksPrompt";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	AuthError,
	hasSession,
	requestPasswordReset,
	resendVerificationEmail,
	resetPassword,
	signIn,
	signInWithCode,
	signOut,
	verifyEmail,
} from "@/lib/auth";
import { emitAuthCacheBoundary } from "@/lib/authCacheBoundary";
import { ensureOk } from "@/lib/errors/read";
import { isAuthPath } from "../utils/authPaths";
import { describeAuthError } from "../utils/errorUtils";

const buildLoginQuery = ({
	next,
	reason,
}: {
	next?: string;
	reason?: string;
}): string => {
	const params = new URLSearchParams();
	if (next) params.set("next", next);
	if (reason) params.set("reason", reason);
	const qs = params.toString();
	return qs ? `?${qs}` : "";
};

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
			await resetPassword(token, password);
			return true;
		},
		onError: (e) => {
			toast.error(describeAuthError(e));
		},
		onSuccess: () => {
			toast.success("Password reset. Log in with your new password.");
			navigate("/login");
		},
	});
};

// The page confirms inline; /check-your-email speaks of a verification link.
export const useRequestPasswordResetMutation = () => {
	return useMutation({
		mutationFn: async (email: string) => {
			await requestPasswordReset(email);
			return true;
		},
		onError: (e) => {
			toast.error(describeAuthError(e));
		},
	});
};

export const useResendVerificationMutation = () =>
	useMutation({
		meta: { errorToast: false },
		mutationFn: (email: string) => resendVerificationEmail(email),
	});

export const useVerifyMutation = (doRedirect = true) => {
	const navigate = useI18nNavigate();

	return useMutation({
		// No toast here — the verify page shows the status inline, so a
		// parallel toast is double-signalling. Errors surface via the
		// verifyMutation.isError branch on the page.
		meta: { errorToast: false },
		mutationFn: async (data: { token: string }) => {
			// 15s ceiling: a hung API or proxy must not leave the page spinning.
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new AuthError("Verification timed out. Try again.", "TIMEOUT"),
						),
					15_000,
				),
			);
			return Promise.race([verifyEmail(data.token), timeout]);
		},
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

export const useRegisterMutation = () => {
	return useMutation({
		// The page shows the error with ErrorNotice.
		meta: { errorToast: false },
		mutationFn: async (body: {
			email: string;
			password: string;
			first_name: string;
			last_name?: string;
			verification_url: string;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/auth/register`, {
				body: JSON.stringify(body),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			// The page presents the error (field problems inline, the rest as a notice).
			await ensureOk(res);
		},
	});
};

// todo: add redirection logic here
export const useLoginMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		// The login page shows every failure inline.
		meta: { errorToast: false },
		mutationFn: async ({
			email,
			password,
			otp,
			code,
		}: {
			email: string;
			password?: string;
			otp?: string;
			/** A one-time code from the email, instead of a password. */
			code?: string;
		}) => {
			if (code) return signInWithCode(email, code);
			return signIn(email, password ?? "", otp || undefined);
		},
		onSuccess: async () => {
			// Clear everything, not an allowlist: a targeted list silently leaks
			// any user-scoped query it forgets to the next user.
			queryClient.clear();
			if (typeof window !== "undefined") {
				try {
					sessionStorage.removeItem("dembrane_ws_selected");
				} catch {}
				// A new sign-in may see the tasks popup again.
				resetPromptSeen();
			}
			emitAuthCacheBoundary();
			await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
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
				await signOut();
			} catch (e) {
				const status = (e as { response?: { status?: number } })?.response
					?.status;
				if (status === 401 || status === 403) {
					return;
				}
				throw e;
			}
		},
		onError: (_error, { next, reason, doRedirect }) => {
			if (doRedirect) {
				navigate(`/login${buildLoginQuery({ next, reason })}`);
			}
		},
		onMutate: async () => {
			await queryClient.cancelQueries();
			// Wipe cache before re-setting session=false — prevents the next user
			// from briefly seeing the previous user's workspaces/projects.
			queryClient.removeQueries();
			queryClient.setQueryData(["auth", "session"], false);
			if (typeof window !== "undefined") {
				try {
					sessionStorage.removeItem("dembrane_ws_selected");
				} catch {}
			}
			emitAuthCacheBoundary();
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
		},
		onSuccess: (_data, { next, reason, doRedirect }) => {
			posthog?.capture("user_logged_out");
			posthog?.reset();
			if (doRedirect) {
				navigate(`/login${buildLoginQuery({ next, reason })}`);
			}
		},
	});
};

export const useAuthenticated = (doRedirect = false, enabled = true) => {
	const logoutMutation = useLogoutMutation();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const hasLoggedOutRef = useRef(false);

	const sessionQuery = useQuery({
		// Callers that don't need the session (e.g. ErrorPage on the participant
		// portal) disable the query so no refresh call is fired at all.
		enabled,
		queryFn: async () => {
			if (!(await hasSession())) throw new Error("No session");
			return true as const;
		},
		queryKey: ["auth", "session"],
		retry: false,
		staleTime: 60_000,
	});

	useEffect(() => {
		if (sessionQuery.isError && doRedirect && !hasLoggedOutRef.current) {
			hasLoggedOutRef.current = true;
			// Preserve full URL through /login; skip auth pages to avoid loops.
			const nextUrl = isAuthPath(location.pathname)
				? undefined
				: location.pathname + location.search + location.hash;
			logoutMutation.mutate({
				doRedirect,
				next: nextUrl,
				reason: searchParams.get("reason") ?? "",
			});
		}
	}, [
		doRedirect,
		location.hash,
		location.pathname,
		location.search,
		logoutMutation,
		searchParams,
		sessionQuery.isError,
	]);

	return {
		isAuthenticated: sessionQuery.data === true,
		loading: sessionQuery.isLoading,
	};
};
