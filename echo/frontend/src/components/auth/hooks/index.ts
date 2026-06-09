import {
	passwordRequest,
	passwordReset,
	registerUserVerify,
} from "@directus/sdk";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { ADMIN_BASE_URL, API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { emitAuthCacheBoundary } from "@/lib/authCacheBoundary";
import { directus } from "@/lib/directus";
import { isAuthPath } from "../utils/authPaths";
import { throwWithMessage } from "../utils/errorUtils";

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

export const useRegisterMutation = () => {
	return useMutation({
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
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				let message = "Registration failed. Please try again.";
				if (typeof data.detail === "string") {
					message = data.detail;
				} else if (Array.isArray(data.detail) && data.detail.length > 0) {
					message = data.detail[0].msg ?? message;
				}
				throw new Error(message);
			}
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
			queryClient.removeQueries({ queryKey: ["users", "me"] });
			queryClient.removeQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.removeQueries({ queryKey: ["v2", "workspaces-context"] });
			if (typeof window !== "undefined") {
				try {
					sessionStorage.removeItem("dembrane_ws_selected");
				} catch {}
			}
			emitAuthCacheBoundary();
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["auth", "session"] }),
				queryClient.invalidateQueries({ queryKey: ["users", "me"] }),
				queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] }),
				queryClient.invalidateQueries({
					queryKey: ["v2", "workspaces-context"],
				}),
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
