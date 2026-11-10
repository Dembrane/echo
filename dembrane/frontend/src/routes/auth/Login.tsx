import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
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
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useLoginMutation } from "@/components/auth/hooks";
import { LoginBlockedNotice } from "@/components/auth/LoginBlockedNotice";
import { LoginRateLimitNotice } from "@/components/auth/LoginRateLimitNotice";
import { ResendVerificationEmail } from "@/components/auth/ResendVerificationEmail";
import { SignedInElsewhere } from "@/components/auth/SignedInElsewhere";
import { SignedInRecoveryNotice } from "@/components/auth/SignedInRecoveryNotice";
import { useResendCooldown } from "@/components/auth/useResendCooldown";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import {
	authErrorCode,
	authErrorStatus,
	authRetryAfter,
	describeAuthError,
	loginFailureCause,
} from "@/components/auth/utils/errorUtils";
import {
	isAccountPath,
	isSafeNextPath,
	resolveNextPath,
} from "@/components/auth/utils/nextPath";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL } from "@/config";
import { promptFor } from "@/features/accounts/help/tasksPromptState";
import {
	fetchTasksSummary,
	tasksSummaryKey,
} from "@/features/accounts/help/tasksSummary";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { track } from "@/lib/analytics/events";
import { identifyHost } from "@/lib/analytics/identity";
import {
	type OtherDevice,
	otherSessions,
	replaceOtherDevice,
	sendSignInCode,
	signOut,
} from "@/lib/auth";
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

/** The wait when a rate-limited answer does not say how long: Better Auth's sign-in window. */
export const LOGIN_RETRY_FALLBACK_SECONDS = 30;

export const LoginRoute = () => {
	useDocumentTitle(t`Log in | dembrane`);
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
	const { runTransition } = useTransitionCurtain();

	const [error, setError] = useState("");
	// Set when the password was right but the email is not verified yet.
	const [unverifiedEmail, setUnverifiedEmail] = useState("");
	const [otpRequired, setOtpRequired] = useState(false);
	// A sign-in refused before it reached dembrane (a 403 without a code of ours).
	const [blocked, setBlocked] = useState(false);
	// Too many tries: the countdown below disables "Log in" until it ends.
	const [rateLimited, setRateLimited] = useState(false);
	const loginWait = useResendCooldown(LOGIN_RETRY_FALLBACK_SECONDS);
	// The sign-in worked but a step after it failed: the address to carry on with.
	const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
	const [continuing, setContinuing] = useState(false);
	const [otpValue, setOtpValue] = useState("");
	// Sign-in with an emailed one-time code: how contacts created by staff or sam sign in.
	const [codeMode, setCodeMode] = useState(false);
	const [codeEmail, setCodeEmail] = useState("");
	const [codeSent, setCodeSent] = useState(false);
	const [code, setCode] = useState("");
	const [codeSending, setCodeSending] = useState(false);
	const resendCooldown = useResendCooldown();
	const [formParent] = useAutoAnimate();
	const pinInputRef = useRef<HTMLDivElement | null>(null);
	const loginMutation = useLoginMutation();
	const posthog = usePostHog();
	const queryClient = useQueryClient();
	// A third device needs an explicit choice of which active device to sign out.
	const [elsewhere, setElsewhere] = useState<{
		email: string;
		devices: OtherDevice[];
	} | null>(null);
	const [replacing, setReplacing] = useState(false);
	const [replacementError, setReplacementError] = useState("");

	// Where a signed-in person goes: onboarding if unfinished, else ?next when it is safe,
	// else the home list. Shared by the password and the emailed-code sign-in.
	const afterSignIn = async (email: string, curtain = true) => {
		// The full person (invited, organisation) is set once /v2/me loads: HostIdentitySync.
		identifyHost(posthog, { email });
		track("user_logged_in");

		const isNewUser = searchParams.get("new") === "true";
		const next = searchParams.get("next");

		// Start transition immediately — user sees smooth curtain right away. Someone who
		// came through the logged-in-elsewhere page has already seen it.
		const transitionPromise = curtain
			? runTransition({
					message: isNewUser ? t`Welcome to dembrane` : t`Welcome back`,
				})
			: Promise.resolve();

		// Check onboarding in parallel with the transition. Small delay
		// ensures the session cookie from login is available. Routing is
		// deliberately simple now (ISSUE-015 / Founder decision D3):
		// everyone lands on the general home /o, with ?next as the only
		// exception. The old single-workspace / last-used auto-redirects
		// were removed — /o is the canonical landing.
		let needsOnboarding = false;
		let onboardingIncomplete = false;
		let accountLanding: string | null = null;
		let wsList: { id: string; org_id?: string }[] = [];
		try {
			await new Promise((r) => setTimeout(r, 300));
			const meResponse = await fetch(`${API_BASE_URL}/v2/me`, {
				credentials: "include",
			});
			if (meResponse.ok) {
				const meData = await meResponse.json();
				// Onboarding reads this cache; it may still hold a 401 from before sign-in.
				queryClient.setQueryData(["v2", "me"], meData);
				needsOnboarding = meData.onboarding_completed === false;
				// Required-but-non-blocking questionnaire (ISSUE-012): if the
				// user is onboarded but never answered, route through the
				// stepper first so they get nudged. The stepper still lets
				// them skip on to /o.
				onboardingIncomplete =
					meData.onboarding_completed === true &&
					!meData.onboarding_answer_json;
			}

			// Someone who came to dembrane through an offer, a customer's contact who has
			// never used it on their own, skips the questionnaire: their organisation's
			// overview, with what to sign or fill in, is where they are expected.
			if (onboardingIncomplete) {
				const summary = await fetchTasksSummary();
				queryClient.setQueryData(tasksSummaryKey, summary);
				const org = promptFor(summary) ?? summary[0];
				if (org) accountLanding = `/o/${org.org_id}/overview`;
			}

			// Workspace list still needed to validate a ?next deep-link
			// target (block cross-user leaks).
			if (!needsOnboarding) {
				const wsResponse = await fetch(`${API_BASE_URL}/v2/workspaces`, {
					credentials: "include",
				});
				if (wsResponse.ok) {
					const wsData = await wsResponse.json();
					wsList = wsData.workspaces ?? [];
				}
			}
		} catch {
			// Swallow — never block login for onboarding check
		}

		await transitionPromise;

		// A signing or account link goes straight to its page: the person may be a named
		// signer with no workspace to set up, and onboarding would drop the link.
		if (isSafeNextPath(next) && !isAuthPath(next) && isAccountPath(next)) {
			navigate(next);
			return;
		}

		if (accountLanding) {
			navigate(accountLanding);
			return;
		}

		if (needsOnboarding || onboardingIncomplete) {
			navigate("/onboarding");
			return;
		}

		// Deep-link priority — but block cross-user leaks: a stale ?next from
		// the previous session can point at a workspace or organisation this
		// account can't see ("Organisation not found"). Fails closed to /o.
		const resolvedNext = resolveNextPath(next, wsList);
		if (resolvedNext) {
			navigate(resolvedNext);
			return;
		}

		// Everyone else: the general home.
		navigate("/o");
	};

	// Every sign-in passes here. When both device slots are occupied, ask before going on.
	const afterCredentials = async (email: string) => {
		const state = await otherSessions();
		if (state.held) {
			// The same curtain as any sign-in; it opens onto the choice instead of the app.
			await runTransition({ message: t`Welcome back` });
			setReplacementError("");
			setElsewhere({ devices: state.devices, email });
			return;
		}
		await afterSignIn(email);
	};

	const logInOnThisDevice = async (sessionId: string) => {
		if (!elsewhere || replacing) return;
		setReplacing(true);
		setReplacementError("");
		try {
			await replaceOtherDevice(sessionId);
			await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
			// /v2/me answered 401 while the sign-in was held.
			await queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			await afterSignIn(elsewhere.email, false);
		} catch (error) {
			const state = await otherSessions().catch(() => null);
			if (state?.held) setElsewhere({ ...elsewhere, devices: state.devices });
			const code = authErrorCode(error);
			setReplacementError(
				code === "HTTP_409" || code === "CONFLICT"
					? t`Your active devices changed. Choose a device again.`
					: t`Something went wrong`,
			);
		} finally {
			setReplacing(false);
		}
	};

	const stayLoggedOut = async () => {
		setElsewhere(null);
		setOtpRequired(false);
		setCode("");
		await signOut().catch(() => {});
	};

	const clearNotices = () => {
		setError("");
		setUnverifiedEmail("");
		setBlocked(false);
		// A wait still running stays on screen: it is why the buttons are off.
		if (loginWait.wait <= 0) setRateLimited(false);
		setSignedInEmail(null);
	};

	// Waits as long as the server said, or a fixed while when it did not.
	const showRateLimit = (error: unknown) => {
		const seconds = authRetryAfter(error) ?? LOGIN_RETRY_FALLBACK_SECONDS;
		loginWait.start(seconds);
		setRateLimited(true);
		track("login_rate_limit_shown", { retry_after_s: seconds });
		return seconds;
	};

	const showBlocked = () => {
		setBlocked(true);
		track("login_blocked_shown");
	};

	// After a sign-in that worked. Whatever fails here is not a failed login: the person
	// is signed in, so they see that and can carry on.
	const continueSignedIn = async (email: string) => {
		setSignedInEmail(null);
		setContinuing(true);
		try {
			await afterCredentials(email);
		} catch {
			setSignedInEmail(email);
		} finally {
			setContinuing(false);
		}
	};

	const submitLogin = async (data: {
		email: string;
		password: string;
		otp?: string;
	}) => {
		if (loginMutation.isPending || loginWait.wait > 0) return;

		const trimmedOtp = data.otp?.trim();
		clearNotices();

		if (otpRequired && (!trimmedOtp || trimmedOtp.length < 6)) {
			setError(t`Enter the 6-digit code from your authenticator app.`);
			return;
		}

		try {
			await loginMutation.mutateAsync({
				email: data.email,
				otp: otpRequired ? trimmedOtp || undefined : undefined,
				password: data.password,
			});
		} catch (error) {
			const code = authErrorCode(error);

			if (code === "INVALID_OTP") {
				setOtpRequired(true);
				if (trimmedOtp && trimmedOtp.length > 0) {
					track("user_login_failed", {
						cause: "wrong_credentials",
						error_code: code,
						http_status: authErrorStatus(error),
					});
					setError(
						t`That code didn't work. Try again with a fresh code from your authenticator app.`,
					);
					setValue("otp", "");
					setOtpValue("");
				}
				// Without a code typed yet, this is the authenticator step, not a failure.
				return;
			}

			const cause = loginFailureCause(error);
			track("user_login_failed", {
				cause,
				error_code: code,
				http_status: authErrorStatus(error),
			});

			setOtpRequired(false);
			setValue("otp", "");
			setOtpValue("");

			if (cause === "rate_limited") {
				showRateLimit(error);
				return;
			}
			if (cause === "blocked") {
				showBlocked();
				return;
			}
			setError(describeAuthError(error, { flow: "password" }));
			if (cause === "unverified") setUnverifiedEmail(data.email);
			return;
		}

		await continueSignedIn(data.email);
	};

	const onSubmit = handleSubmit((formData) => submitLogin(formData));

	// The code sign-in keeps its own wording ("request a new code").
	const showCodeFailure = (e: unknown) => {
		const cause = loginFailureCause(e);
		if (cause === "rate_limited") {
			const seconds = showRateLimit(e);
			if (codeSent) resendCooldown.start(seconds);
		} else if (cause === "blocked") showBlocked();
		else setError(describeAuthError(e, { flow: "code" }));
	};

	const requestCode = async () => {
		if (codeSending || loginWait.wait > 0) return;
		if (codeSent && resendCooldown.wait > 0) return;
		const resend = codeSent;
		clearNotices();
		setCodeSending(true);
		try {
			await sendSignInCode(codeEmail.trim());
			setCodeSent(true);
			setCode("");
			resendCooldown.start();
			if (resend) toast.success(t`We sent a new code to ${codeEmail}.`);
		} catch (e) {
			showCodeFailure(e);
		} finally {
			setCodeSending(false);
		}
	};

	const submitCode = async (value: string) => {
		if (loginMutation.isPending || value.length < 6 || loginWait.wait > 0)
			return;
		clearNotices();
		try {
			await loginMutation.mutateAsync({ code: value, email: codeEmail.trim() });
		} catch (e) {
			showCodeFailure(e);
			setCode("");
			return;
		}
		await continueSignedIn(codeEmail.trim());
	};

	const switchToCode = () => {
		setCodeEmail(getValues("email") || lockedEmail || "");
		setCodeMode(true);
		setCodeSent(false);
		clearNotices();
	};

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
		<div className="h-full w-full">
			{elsewhere && (
				<SignedInElsewhere
					devices={elsewhere.devices}
					loading={replacing}
					error={replacementError}
					onConfirm={logInOnThisDevice}
					onCancel={stayLoggedOut}
				/>
			)}
			<Stack className="h-full">
				<Stack className="flex-grow" gap="md">
					<Title order={2}>
						<Trans>Welcome</Trans>
					</Title>

					{searchParams.get("verified") === "1" && (
						<Alert color="green" variant="light">
							<Trans>Your email is verified. Log in to continue.</Trans>
						</Alert>
					)}

					{(searchParams.get("new") === "true" ||
						!!searchParams.get("next")) && (
						<Text>
							<Trans>Please log in to continue.</Trans>
						</Text>
					)}

					{signedInEmail && (
						<SignedInRecoveryNotice
							loading={continuing}
							onContinue={() => void continueSignedIn(signedInEmail)}
						/>
					)}

					{rateLimited && (
						<LoginRateLimitNotice
							seconds={loginWait.wait}
							flow={codeMode ? "code" : "password"}
						/>
					)}

					{blocked && (
						<LoginBlockedNotice
							onUseCode={codeMode ? undefined : switchToCode}
						/>
					)}

					{codeMode ? (
						<Stack gap="md">
							{error && <Alert color="red">{error}</Alert>}
							{!codeSent ? (
								<>
									<TextInput
										label={<Trans>Email</Trans>}
										size="md"
										type="email"
										autoComplete="email"
										value={codeEmail}
										onChange={(e) => setCodeEmail(e.currentTarget.value)}
										{...testId("auth-login-code-email-input")}
									/>
									<div style={{ marginTop: 8 }}>
										<Button
											variant="filled"
											size="md"
											fullWidth
											loading={codeSending}
											disabled={!codeEmail.includes("@") || loginWait.wait > 0}
											onClick={requestCode}
											{...testId("auth-login-code-send")}
										>
											<Trans>Email me a code</Trans>
										</Button>
									</div>
								</>
							) : (
								<>
									<Stack gap="xs">
										<Text size="sm">
											<Trans>We sent a six-digit code to {codeEmail}.</Trans>
										</Text>
										<PinInput
											length={6}
											type="number"
											size="md"
											oneTimeCode
											inputMode="numeric"
											value={code}
											onChange={setCode}
											onComplete={submitCode}
											{...testId("auth-login-code-input")}
										/>
									</Stack>
									<div style={{ marginTop: 8 }}>
										<Button
											variant="filled"
											size="md"
											fullWidth
											loading={loginMutation.isPending}
											disabled={code.length < 6 || loginWait.wait > 0}
											onClick={() => submitCode(code)}
										>
											<Trans>Log in</Trans>
										</Button>
									</div>
								</>
							)}
						</Stack>
					) : (
						<form onSubmit={onSubmit}>
							<Stack gap="md" ref={formParent}>
								<input type="hidden" {...register("otp")} />
								{error && !otpRequired && <Alert color="red">{error}</Alert>}
								{unverifiedEmail && !otpRequired && (
									<ResendVerificationEmail email={unverifiedEmail} />
								)}

								{otpRequired ? (
									<Stack gap="xs">
										<Text size="sm">
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
										{error && <Alert color="red">{error}</Alert>}
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
											size="md"
											{...register("email")}
											{...testId("auth-login-email-input")}
											placeholder={t`Email`}
											required
											type="email"
											// Arriving with ?email= (from /register, or an
											// invite link through AcceptInviteRoute) locks the
											// address the account was made for. The hints are
											// deliberate: "off" and "new-password" keep a
											// password manager from filling a different saved
											// account in, which once logged a fresh signup in as
											// another user (QA audit 2026-04-23). Otherwise the
											// fields carry the standard sign-in hints.
											readOnly={Boolean(lockedEmail)}
											autoComplete={lockedEmail ? "off" : "username"}
										/>
										<PasswordInput
											label={<Trans>Password</Trans>}
											size="md"
											{...register("password")}
											{...testId("auth-login-password-input")}
											placeholder={t`Password`}
											required
											// See the email field: new-password only for a
											// locked address.
											autoComplete={
												lockedEmail ? "new-password" : "current-password"
											}
										/>
									</>
								)}
								{/* The submit belongs to the whole form, not the last field:
								    24 above it (16 from the stack plus 8), against 4 inside a
								    field and 16 between fields. */}
								<div style={{ marginTop: 8 }}>
									<Button
										variant="filled"
										size="md"
										type="submit"
										fullWidth
										loading={loginMutation.isPending || continuing}
										disabled={loginWait.wait > 0}
										{...testId("auth-login-submit-button")}
									>
										{otpRequired ? (
											<Trans>Verify code</Trans>
										) : (
											<Trans>Log in</Trans>
										)}
									</Button>
								</div>
							</Stack>
						</form>
					)}
					{/* Tertiary ways in, centred under the primary button. */}
					{codeMode ? (
						<Stack gap="xs" align="center">
							{codeSent && (
								<Button
									variant="subtle"
									color="gray"
									loading={codeSending}
									disabled={resendCooldown.wait > 0}
									onClick={requestCode}
									{...testId("auth-login-code-resend")}
								>
									{resendCooldown.wait > 0 ? (
										<Trans>Send a new code in {resendCooldown.wait}s</Trans>
									) : (
										<Trans>Send a new code</Trans>
									)}
								</Button>
							)}
							<Button
								variant="subtle"
								color="gray"
								onClick={() => {
									setCodeMode(false);
									clearNotices();
								}}
							>
								<Trans>Use my password instead</Trans>
							</Button>
						</Stack>
					) : (
						!otpRequired && (
							<Stack gap="xs" align="center">
								{/* The blocked notice offers the code itself, as every notice
								    carries its own way out; one offer on the page is enough. */}
								{!blocked && (
									<Button
										variant="subtle"
										color="gray"
										onClick={switchToCode}
										{...testId("auth-login-code-mode")}
									>
										<Trans>Email me a sign-in code instead</Trans>
									</Button>
								)}
								<Button
									variant="subtle"
									color="gray"
									component={I18nLink}
									to="/request-password-reset"
									{...testId("auth-login-forgot-password-link")}
								>
									<Trans>Forgot your password?</Trans>
								</Button>
							</Stack>
						)
					)}

					<Divider variant="dashed" label={t`or`} labelPosition="center" />

					<Button
						component={I18nLink}
						to="/register"
						size="md"
						fullWidth
						{...testId("auth-login-register-button")}
					>
						<Trans>Create an account</Trans>
					</Button>

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
		</div>
	);
};
