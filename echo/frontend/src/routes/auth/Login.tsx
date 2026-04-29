import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
	Container,
	Divider,
	PasswordInput,
	PinInput,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useLoginMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { useCreateProjectMutation } from "@/components/project/hooks";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";

// const LoginWithProvider = ({
// 	provider,
// 	icon,
// 	label,
// }: {
// 	provider: string;
// 	icon: React.ReactNode;
// 	label: string;
// }) => {
// 	const { language } = useLanguage();
// 	return (
// 		<Button
// 			component="a"
// 			href={`${DIRECTUS_PUBLIC_URL}/auth/login/${provider}?redirect=${encodeURIComponent(
// 				`${window.location.origin}/${language}/projects`,
// 			)}`}
// 			size="lg"
// 			c="gray"
// 			color="gray.6"
// 			variant="outline"
// 			rightSection={icon}
// 			fullWidth
// 		>
// 			{label}
// 		</Button>
// 	);
// };

export const LoginRoute = () => {
	useDocumentTitle(t`Login | dembrane`);
	const [searchParams, _setSearchParams] = useSearchParams();

	// When we arrive from /register with ?email=..., pre-seed the email
	// and lock the input. Prevents Chrome's password manager from quietly
	// swapping in a saved account on submit — the scenario reported in
	// 2026-04-23 QA audit where a fresh signup ended up logged in as a
	// different seeded user.
	const lockedEmail = searchParams.get("email");

	const { register, handleSubmit, setValue, getValues } = useForm<{
		email: string;
		password: string;
		otp: string;
	}>({
		defaultValues: {
			email: lockedEmail ?? "",
			otp: "",
		},
		shouldUnregister: false,
	});

	const navigate = useI18nNavigate();
	const createProjectMutation = useCreateProjectMutation();
	const { runTransition } = useTransitionCurtain();

	const [error, setError] = useState("");
	const [otpRequired, setOtpRequired] = useState(false);
	const [otpValue, setOtpValue] = useState("");
	const [formParent] = useAutoAnimate();
	const pinInputRef = useRef<HTMLDivElement | null>(null);
	const loginMutation = useLoginMutation();
	const posthog = usePostHog();

	const submitLogin = async (data: {
		email: string;
		password: string;
		otp?: string;
	}) => {
		if (loginMutation.isPending) return;

		const trimmedOtp = data.otp?.trim();

		try {
			setError("");

			if (otpRequired && (!trimmedOtp || trimmedOtp.length < 6)) {
				setError(t`Enter the 6-digit code from your authenticator app.`);
				return;
			}

			await loginMutation.mutateAsync({
				email: data.email,
				otp: otpRequired ? trimmedOtp || undefined : undefined,
				password: data.password,
			});

			posthog?.identify(data.email);
			posthog?.capture("user_logged_in", { email: data.email });

			const isNewUser = searchParams.get("new") === "true";
			const next = searchParams.get("next");

			// Start transition immediately — user sees smooth curtain right away
			const transitionPromise = runTransition({
				message: isNewUser ? t`Welcome to dembrane` : t`Welcome back`,
			});

			// Check onboarding + workspace count in parallel with transition.
			// Small delay ensures the session cookie from login is available.
			let needsOnboarding = false;
			let workspaceCount = 0;
			let firstWorkspaceId: string | null = null;
			let isOrganisationAdmin = false;
			try {
				await new Promise((r) => setTimeout(r, 300));
				const meResponse = await fetch(`${API_BASE_URL}/v2/me`, {
					credentials: "include",
				});
				if (meResponse.ok) {
					const meData = await meResponse.json();
					needsOnboarding = meData.onboarding_completed === false;
					isOrganisationAdmin = (meData.orgs ?? []).some(
						(o: { role: string }) => o.role === "owner" || o.role === "admin",
					);
				}

				// If onboarded, check workspace count for routing
				if (!needsOnboarding) {
					const wsResponse = await fetch(`${API_BASE_URL}/v2/workspaces`, {
						credentials: "include",
					});
					if (wsResponse.ok) {
						const wsData = await wsResponse.json();
						const wsList = wsData.workspaces ?? [];
						workspaceCount = wsList.length;
						if (wsList.length > 0) {
							firstWorkspaceId = wsList[0].id;
						}
					}
				}
			} catch {
				// Swallow — never block login for onboarding check
			}

			await transitionPromise;

			if (needsOnboarding) {
				navigate("/onboarding");
				return;
			}

			// Deep link takes priority
			if (!!next && next !== "/login") {
				navigate(next);
				return;
			}

			// Routing:
			// - Solo user (1 workspace) → straight to projects
			// - Returning multi-workspace user → last-used workspace (if still valid)
			// - First-time multi-workspace user → selector
			const lastUsedId = localStorage.getItem("dembrane_last_workspace_id");
			const lastStillValid = lastUsedId && workspaceCount > 0 &&
				(await fetch(`${API_BASE_URL}/v2/workspaces`, { credentials: "include" })
					.then((r) => r.ok ? r.json() : null)
					.then((d) => d?.workspaces?.some((w: { id: string }) => w.id === lastUsedId))
					.catch(() => false));

			if (workspaceCount === 1 && firstWorkspaceId) {
				navigate(`/w/${firstWorkspaceId}/projects`);
			} else if (lastStillValid) {
				navigate(`/w/${lastUsedId}/projects`);
			} else if (workspaceCount > 1 || isOrganisationAdmin) {
				navigate("/w");
			} else if (firstWorkspaceId) {
				navigate(`/w/${firstWorkspaceId}/projects`);
			} else {
				navigate("/projects");
			}
		} catch (error) {
			// biome-ignore lint/suspicious/noExplicitAny: <todo>
			const errors = (error as any)?.errors;
			const firstError = Array.isArray(errors) ? errors[0] : undefined;
			const code = firstError?.extensions?.code;
			const message =
				firstError?.message && firstError.message !== ""
					? firstError.message
					: undefined;

			posthog?.capture("user_login_failed", {
				email: data.email,
				error_code: code,
			});

			if (code === "INVALID_OTP") {
				setOtpRequired(true);
				if (trimmedOtp && trimmedOtp.length > 0) {
					setError(
						t`That code didn't work. Try again with a fresh code from your authenticator app.`,
					);
					setValue("otp", "");
					setOtpValue("");
				} else {
					setError("");
				}
				return;
			}

			setOtpRequired(false);
			setValue("otp", "");
			setOtpValue("");

			if (message) {
				setError(message);
			} else {
				setError(t`Something went wrong`);
			}
		}
	};

	const onSubmit = handleSubmit((formData) => submitLogin(formData));

	useEffect(() => {
		if (searchParams.get("reason") === "INVALID_CREDENTIALS") {
			setError(t`Invalid credentials.`);
		}

		if (searchParams.get("reason") === "INVALID_PROVIDER") {
			setError(
				t`You must login with the same provider you used to sign up. If you face any issues, please contact support.`,
			);
		}
	}, [searchParams]);

	useEffect(() => {
		if (otpRequired) {
			const input = pinInputRef.current?.querySelector("input");
			if (input) {
				input.focus();
			}
		}
	}, [otpRequired]);

	return (
		<Container size="sm" className="!h-full">
			<Stack className="h-full">
				<Stack className="flex-grow" gap="md">
					<Title order={1}>
						<Trans>Welcome!</Trans>
					</Title>

					{searchParams.get("verified") === "1" && (
						<Alert color="green" variant="light">
							<Trans>
								Your email is verified. Log in to continue.
							</Trans>
						</Alert>
					)}

					{(searchParams.get("new") === "true" ||
						!!searchParams.get("next")) && (
						<Text>
							<Trans>Please log in to continue.</Trans>
						</Text>
					)}

					<form onSubmit={onSubmit}>
						<Stack gap="sm" ref={formParent}>
							<input type="hidden" {...register("otp")} />
							{error && !otpRequired && <Alert color="red">{error}</Alert>}

							{otpRequired ? (
								<Stack gap="xs">
									<Text fw={500} size="sm">
										<Trans>Authenticator code</Trans>
									</Text>
									<PinInput
										length={6}
										type="number"
										size="md"
										oneTimeCode
										value={otpValue}
										rootRef={pinInputRef}
										onChange={(value) => {
											setOtpValue(value);
											setValue("otp", value);
										}}
										onComplete={(value) => {
											setOtpValue(value);
											setValue("otp", value);
											const { email, password } = getValues();
											void submitLogin({
												email,
												otp: value,
												password,
											});
										}}
										inputMode="numeric"
										name="otp"
									/>
									{error && (
										<Text size="sm" c="red">
											{error}
										</Text>
									)}
									<Text size="sm" c="dimmed">
										<Trans>
											Open your authenticator app and enter the current
											six-digit code.
										</Trans>
									</Text>
								</Stack>
							) : (
								<>
									<TextInput
										label={<Trans>Email</Trans>}
										size="lg"
										{...register("email")}
										{...testId("auth-login-email-input")}
										placeholder={t`Email`}
										required
										type="email"
										// When arriving from /register, the email is
										// locked. Defends against password-manager
										// autofill swapping in a different account.
										readOnly={Boolean(lockedEmail)}
										autoComplete={lockedEmail ? "off" : "email"}
									/>
									<PasswordInput
										label={<Trans>Password</Trans>}
										size="lg"
										{...register("password")}
										{...testId("auth-login-password-input")}
										placeholder={t`Password`}
										required
										// new-password is the standard escape hatch to
										// stop Chrome/Firefox auto-filling a saved
										// password into this form.
										autoComplete={lockedEmail ? "new-password" : "current-password"}
									/>
								</>
							)}
							{!otpRequired && (
								<div className="w-full text-right">
									<I18nLink to="/request-password-reset">
										<Anchor
											variant="outline"
											{...testId("auth-login-forgot-password-link")}
										>
											<Trans>Forgot your password?</Trans>
										</Anchor>
									</I18nLink>
								</div>
							)}
							<Button
								size="lg"
								type="submit"
								loading={loginMutation.isPending}
								{...testId("auth-login-submit-button")}
							>
								{otpRequired ? (
									<Trans>Verify code</Trans>
								) : (
									<Trans>Login</Trans>
								)}
							</Button>
						</Stack>
					</form>

					<Divider variant="dashed" label={t`or`} labelPosition="center" />

					<I18nLink to="/register">
						<Button
							size="lg"
							variant="outline"
							fullWidth
							{...testId("auth-login-register-button")}
						>
							<Trans>Create an account</Trans>
						</Button>
					</I18nLink>

					{/* <Box>
						{providerQuery.data?.find(
							(provider) => provider.name === "google",
						) && (
							<LoginWithProvider
								provider="google"
								icon={<IconBrandGoogle />}
								label={t`Sign in with Google`}
							/>
						)}
					</Box> */}
				</Stack>
			</Stack>
		</Container>
	);
};
