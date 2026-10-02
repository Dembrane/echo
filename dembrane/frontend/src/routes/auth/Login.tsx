import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
	Divider,
	Group,
	Modal,
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
import { ResendVerificationEmail } from "@/components/auth/ResendVerificationEmail";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import {
	authErrorCode,
	describeAuthError,
} from "@/components/auth/utils/errorUtils";
import {
	isAccountPath,
	isSafeNextPath,
	resolveNextPath,
} from "@/components/auth/utils/nextPath";
import { I18nLink } from "@/components/common/i18nLink";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	otherSessions,
	replaceOtherSessions,
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
	const { runTransition } = useTransitionCurtain();

	const [error, setError] = useState("");
	// Set when the password was right but the email is not verified yet.
	const [unverifiedEmail, setUnverifiedEmail] = useState("");
	const [otpRequired, setOtpRequired] = useState(false);
	const [otpValue, setOtpValue] = useState("");
	// Sign-in with an emailed one-time code: how contacts created by staff or sam sign in.
	const [codeMode, setCodeMode] = useState(false);
	const [codeEmail, setCodeEmail] = useState("");
	const [codeSent, setCodeSent] = useState(false);
	const [code, setCode] = useState("");
	const [codeSending, setCodeSending] = useState(false);
	const [formParent] = useAutoAnimate();
	const pinInputRef = useRef<HTMLDivElement | null>(null);
	const loginMutation = useLoginMutation();
	const posthog = usePostHog();
	const queryClient = useQueryClient();
	// Set when the sign-in was right but the account is signed in on another browser: the
	// person chooses here whether to replace that session.
	const [elsewhere, setElsewhere] = useState<{
		email: string;
		since: string | null;
	} | null>(null);
	const [replacing, setReplacing] = useState(false);

	// Where a signed-in person goes: onboarding if unfinished, else ?next when it is safe,
	// else the home list. Shared by the password and the emailed-code sign-in.
	const afterSignIn = async (email: string) => {
		posthog?.identify(email);
		posthog?.capture("user_logged_in", { email: email });

		const isNewUser = searchParams.get("new") === "true";
		const next = searchParams.get("next");

		// Start transition immediately — user sees smooth curtain right away
		const transitionPromise = runTransition({
			message: isNewUser ? t`Welcome to dembrane` : t`Welcome back`,
		});

		// Check onboarding in parallel with the transition. Small delay
		// ensures the session cookie from login is available. Routing is
		// deliberately simple now (ISSUE-015 / Founder decision D3):
		// everyone lands on the general home /o, with ?next as the only
		// exception. The old single-workspace / last-used auto-redirects
		// were removed — /o is the canonical landing.
		let needsOnboarding = false;
		let onboardingIncomplete = false;
		let wsList: { id: string; org_id?: string }[] = [];
		try {
			await new Promise((r) => setTimeout(r, 300));
			const meResponse = await fetch(`${API_BASE_URL}/v2/me`, {
				credentials: "include",
			});
			if (meResponse.ok) {
				const meData = await meResponse.json();
				needsOnboarding = meData.onboarding_completed === false;
				// Required-but-non-blocking questionnaire (ISSUE-012): if the
				// user is onboarded but never answered, route through the
				// stepper first so they get nudged. The stepper still lets
				// them skip on to /o.
				onboardingIncomplete =
					meData.onboarding_completed === true &&
					!meData.onboarding_answer_json;
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

	// Every sign-in passes here. One browser per account: when another is signed in, ask
	// before going on.
	const afterCredentials = async (email: string) => {
		const state = await otherSessions();
		if (state.held) {
			setElsewhere({ email, since: state.since });
			return;
		}
		await afterSignIn(email);
	};

	const logInAnyway = async () => {
		if (!elsewhere || replacing) return;
		setReplacing(true);
		try {
			await replaceOtherSessions();
			await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
			const { email } = elsewhere;
			setElsewhere(null);
			await afterSignIn(email);
		} catch {
			setElsewhere(null);
			setError(t`Something went wrong`);
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

	const submitLogin = async (data: {
		email: string;
		password: string;
		otp?: string;
	}) => {
		if (loginMutation.isPending) return;

		const trimmedOtp = data.otp?.trim();

		try {
			setError("");
			setUnverifiedEmail("");

			if (otpRequired && (!trimmedOtp || trimmedOtp.length < 6)) {
				setError(t`Enter the 6-digit code from your authenticator app.`);
				return;
			}

			await loginMutation.mutateAsync({
				email: data.email,
				otp: otpRequired ? trimmedOtp || undefined : undefined,
				password: data.password,
			});

			await afterCredentials(data.email);
		} catch (error) {
			const code = authErrorCode(error);

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

			// A failure with no known code reads as the Directus login did.
			if (
				code === "EMAIL_NOT_VERIFIED" ||
				code === "INVALID_EMAIL_OR_PASSWORD"
			) {
				setError(describeAuthError(error));
				if (code === "EMAIL_NOT_VERIFIED") setUnverifiedEmail(data.email);
			} else {
				setError(t`Something went wrong`);
			}
		}
	};

	const onSubmit = handleSubmit((formData) => submitLogin(formData));

	const requestCode = async () => {
		setError("");
		setCodeSending(true);
		try {
			await sendSignInCode(codeEmail.trim());
			setCodeSent(true);
			setCode("");
		} catch (e) {
			setError(describeAuthError(e));
		} finally {
			setCodeSending(false);
		}
	};

	const submitCode = async (value: string) => {
		if (loginMutation.isPending || value.length < 6) return;
		setError("");
		try {
			await loginMutation.mutateAsync({ code: value, email: codeEmail.trim() });
			await afterCredentials(codeEmail.trim());
		} catch (e) {
			setError(describeAuthError(e));
			setCode("");
		}
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

	const elsewhereSince = elsewhere?.since
		? new Date(elsewhere.since).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;

	return (
		<div className="h-full w-full">
			<Modal
				opened={elsewhere !== null}
				onClose={stayLoggedOut}
				closeOnClickOutside={false}
				centered
				title={<Trans>This account is logged in somewhere else</Trans>}
				{...testId("auth-login-elsewhere-modal")}
			>
				<Stack gap="md">
					<Text>
						{elsewhereSince ? (
							<Trans>
								It has been logged in on another device since {elsewhereSince}.
								For security, an account can be logged in on one device at a
								time.
							</Trans>
						) : (
							<Trans>
								It is logged in on another device. For security, an account can
								be logged in on one device at a time.
							</Trans>
						)}
					</Text>
					<Text>
						<Trans>Logging in here logs the other device out.</Trans>
					</Text>
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={stayLoggedOut}
							disabled={replacing}
							{...testId("auth-login-elsewhere-cancel")}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							onClick={logInAnyway}
							loading={replacing}
							{...testId("auth-login-elsewhere-confirm")}
						>
							<Trans>Log in anyway</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
			<Stack className="h-full">
				<Stack className="flex-grow" gap="md">
					<Title order={1}>
						<Trans>Welcome!</Trans>
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

					{codeMode ? (
						<Stack gap="sm">
							{error && <Alert color="red">{error}</Alert>}
							{!codeSent ? (
								<>
									<TextInput
										label={<Trans>Email</Trans>}
										size="lg"
										type="email"
										autoComplete="email"
										value={codeEmail}
										onChange={(e) => setCodeEmail(e.currentTarget.value)}
										{...testId("auth-login-code-email-input")}
									/>
									<Button
										size="lg"
										fullWidth
										loading={codeSending}
										disabled={!codeEmail.includes("@")}
										onClick={requestCode}
										{...testId("auth-login-code-send")}
									>
										<Trans>Email me a code</Trans>
									</Button>
								</>
							) : (
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
									<Button
										size="lg"
										fullWidth
										loading={loginMutation.isPending}
										disabled={code.length < 6}
										onClick={() => submitCode(code)}
									>
										<Trans>Sign in</Trans>
									</Button>
									<Anchor
										component="button"
										size="sm"
										onClick={requestCode}
										ta="left"
									>
										<Trans>Send a new code</Trans>
									</Anchor>
								</Stack>
							)}
							<Anchor
								component="button"
								size="sm"
								ta="left"
								onClick={() => {
									setCodeMode(false);
									setError("");
								}}
							>
								<Trans>Use my password instead</Trans>
							</Anchor>
						</Stack>
					) : (
						<form onSubmit={onSubmit}>
							<Stack gap="sm" ref={formParent}>
								<input type="hidden" {...register("otp")} />
								{error && !otpRequired && <Alert color="red">{error}</Alert>}
								{unverifiedEmail && !otpRequired && (
									<ResendVerificationEmail email={unverifiedEmail} />
								)}

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
											autoComplete={
												lockedEmail ? "new-password" : "current-password"
											}
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
								<div>
									<Button
										size="lg"
										type="submit"
										fullWidth
										loading={loginMutation.isPending}
										{...testId("auth-login-submit-button")}
									>
										{otpRequired ? (
											<Trans>Verify code</Trans>
										) : (
											<Trans>Login</Trans>
										)}
									</Button>
								</div>
							</Stack>
						</form>
					)}
					{!codeMode && !otpRequired && (
						<Anchor
							component="button"
							size="sm"
							ta="left"
							onClick={() => {
								setCodeEmail(getValues("email") || lockedEmail || "");
								setCodeMode(true);
								setCodeSent(false);
								setError("");
							}}
							{...testId("auth-login-code-mode")}
						>
							<Trans>Email me a sign-in code instead</Trans>
						</Anchor>
					)}

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
		</div>
	);
};
