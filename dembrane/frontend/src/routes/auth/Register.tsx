import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Checkbox,
	Collapse,
	Divider,
	Group,
	List,
	PasswordInput,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { type FormEvent, useRef, useState } from "react";
import { useForm, useFormState, useWatch } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useRegisterMutation } from "@/components/auth/hooks";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { ResendVerificationEmail } from "@/components/auth/ResendVerificationEmail";
import { I18nLink } from "@/components/common/i18nLink";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { ADMIN_BASE_URL, LEGAL_TERMS_URL } from "@/config";
import { validatePassword } from "@/lib/passwordPolicy";
import { testId } from "@/lib/testUtils";

export const RegisterRoute = () => {
	useDocumentTitle(t`Register | dembrane`);
	const [searchParams] = useSearchParams();
	// Email pre-filled from an invite link's `email` query param. When
	// present, the email field is locked to prevent accidental typos that
	// would orphan the user's signup from the inviter's workspace (the
	// invite is matched by email, so a mismatch means the invite never
	// auto-accepts and the user gets a stray personal organisation).
	const invitedEmail = (searchParams.get("email") || "").toLowerCase().trim();
	const lockedEmail = invitedEmail.length > 0 && invitedEmail.includes("@");
	const { register, handleSubmit, watch, control } = useForm<{
		email: string;
		password: string;
		confirmPassword: string;
		first_name: string;
		last_name: string;
	}>({
		defaultValues: lockedEmail ? { email: invitedEmail } : undefined,
	});

	// Read at the top of the component: react-hook-form only repaints for the
	// errors that are read during render, and React Compiler defers reads that
	// sit inside conditional steps.
	const { errors } = useFormState({ control });
	const firstNameError = errors.first_name?.message;
	const emailError = errors.email?.message;
	const passwordFieldError = errors.password?.message;
	const confirmFieldError = errors.confirmPassword?.message;

	const [step, setStep] = useState(0);
	const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
	const [orgHelpOpen, { toggle: toggleOrgHelp }] = useDisclosure(false);
	// ISSUE-013: explicit acceptance of the general terms. Required before
	// continuing; the timestamp is recorded server-side at app_user creation.
	const [termsAccepted, setTermsAccepted] = useState(false);
	// Continue and Create account stay enabled so a missing answer is named on
	// the field instead of the button silently doing nothing.
	const [termsError, setTermsError] = useState("");
	const [passwordError, setPasswordError] = useState("");
	const [confirmError, setConfirmError] = useState("");
	const termsRef = useRef<HTMLInputElement>(null);

	const registerMutation = useRegisterMutation();
	const posthog = usePostHog();

	const checkTerms = () => {
		if (!termsAccepted) setTermsError(t`Accept the terms to continue`);
		return termsAccepted;
	};

	// handleSubmit, not trigger(): only a submitted form re-validates as you type.
	// Built per event, not at render, so React Compiler accepts the ref read.
	const submitDetails = (e: FormEvent<HTMLFormElement>) =>
		handleSubmit(() => {
			if (!checkTerms()) {
				termsRef.current?.focus();
				return;
			}
			// Funnel step: $pageview (/register) -> registration_details_completed
			// -> user_registered. Time between steps shows where people stall.
			posthog?.capture("registration_details_completed", {
				from_invite: lockedEmail,
			});
			setStep(1);
		}, checkTerms)(e);

	const submitPassword = handleSubmit(async (data) => {
		setPasswordError("");
		setConfirmError("");
		if (!validatePassword(data.password).isValid) {
			setPasswordError(t`Password does not meet the requirements.`);
			return;
		}
		if (data.password !== data.confirmPassword) {
			setConfirmError(t`Passwords do not match`);
			return;
		}

		registerMutation.mutate(
			{
				email: data.email,
				first_name: data.first_name,
				password: data.password,
				verification_url: `${ADMIN_BASE_URL}/verify-email`,
				...(data.last_name?.trim() ? { last_name: data.last_name.trim() } : {}),
			},
			{
				onSuccess: () => {
					posthog?.identify(data.email);
					posthog?.capture("user_registered", {
						email: data.email,
						first_name: data.first_name,
					});
					setSubmittedEmail(data.email);
					setStep(2);
				},
			},
		);
	});

	// Enter submits whichever step is showing. The password fields only exist on
	// step 2, so the password handler must not run before then.
	const onSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (step === 0) return submitDetails(e);
		if (step === 1) return submitPassword(e);
	};

	const emailWatch = watch("email");
	// useWatch, not watch(): React Compiler memoizes watch() so it never updates.
	const password = useWatch({ control, name: "password" }) ?? "";

	return (
		<div className="h-full w-full">
			<Stack gap="lg">
				<Stack gap={4}>
					<Title order={2}>
						<Trans>Create an account</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>Three quick steps and you're in.</Trans>
					</Text>
				</Stack>

				<Stepper active={step} size="sm" iconSize={28}>
					<Stepper.Step label={t`Your details`} />
					<Stepper.Step label={t`Create password`} />
					<Stepper.Step label={t`Verify email`} />
				</Stepper>

				<form onSubmit={onSubmit} noValidate>
					<Stack gap="md">
						{registerMutation.error && (
							<ErrorNotice error={registerMutation.error} />
						)}

						{step === 0 && (
							<>
								<TextInput
									size="md"
									autoFocus
									label={t`First name`}
									error={firstNameError}
									{...register("first_name", {
										required: t`Enter your first name`,
										validate: (v) =>
											v.trim().length > 0 || t`Enter your first name`,
									})}
									{...testId("auth-register-first-name-input")}
									placeholder={t`John`}
								/>
								<TextInput
									size="md"
									label={t`Last name`}
									description={t`Optional`}
									{...register("last_name")}
									{...testId("auth-register-last-name-input")}
									placeholder={t`Doe`}
								/>
								<TextInput
									size="md"
									label={t`Email address`}
									error={emailError}
									{...register("email", {
										required: t`Enter your email`,
										validate: (v) =>
											v.includes("@") || t`Enter a valid email address`,
									})}
									{...testId("auth-register-email-input")}
									placeholder={t`john@doe.com`}
									type="email"
									readOnly={lockedEmail}
									description={
										lockedEmail
											? t`Locked to match the invite. To use a different address, ask the admin to re-invite that email.`
											: undefined
									}
								/>
								<Checkbox
									size="md"
									ref={termsRef}
									checked={termsAccepted}
									error={termsError || undefined}
									onChange={(e) => {
										setTermsAccepted(e.currentTarget.checked);
										if (e.currentTarget.checked) setTermsError("");
									}}
									{...testId("auth-register-terms-checkbox")}
									label={
										<Text size="sm">
											<Trans>
												I have read and accept the{" "}
												<Anchor
													href={LEGAL_TERMS_URL}
													target="_blank"
													rel="noreferrer"
												>
													terms
												</Anchor>
											</Trans>
										</Text>
									}
								/>
								<Button
									variant="filled"
									size="md"
									type="submit"
									{...testId("auth-register-continue-button")}
								>
									<Trans>Continue</Trans>
								</Button>
							</>
						)}

						{step === 1 && (
							<>
								<PasswordInput
									size="md"
									autoFocus
									label={t`Password`}
									error={passwordFieldError || passwordError || undefined}
									{...register("password", {
										onChange: () => setPasswordError(""),
										required: t`Enter a password`,
									})}
									{...testId("auth-register-password-input")}
								/>
								<PasswordRequirements value={password} />
								<PasswordInput
									size="md"
									label={t`Confirm password`}
									error={confirmFieldError || confirmError || undefined}
									{...register("confirmPassword", {
										onChange: () => setConfirmError(""),
										required: t`Confirm your password`,
									})}
									{...testId("auth-register-confirm-password-input")}
								/>
								{/* A row of steps: Back on the left, the pill on the right (rules.css). */}
								<Group data-steps gap="md" wrap="nowrap">
									<Button
										variant="subtle"
										color="gray"
										size="md"
										onClick={() => setStep(0)}
										className="shrink-0"
									>
										<Trans>Back</Trans>
									</Button>
									<Button
										variant="filled"
										fullWidth
										size="md"
										type="submit"
										loading={registerMutation.isPending}
										{...testId("auth-register-submit-button")}
									>
										<Trans>Create account</Trans>
									</Button>
								</Group>
							</>
						)}

						{step === 2 && (
							<Stack gap="md" {...testId("auth-register-verify-step")}>
								<Title order={4}>
									<Trans>Check your email</Trans>
								</Title>
								<Text c="dimmed">
									<Trans>
										We've sent a verification link to{" "}
										<Text span c="dark">
											{submittedEmail ?? emailWatch}
										</Text>
										. Open the email and click the link to continue.
									</Trans>
								</Text>
								<Stack gap="xs">
									<Text size="xs" c="dimmed">
										<Trans>
											Didn't get it? Check your spam or junk folder. The email
											comes from dembrane.com.
										</Trans>
									</Text>
									<ResendVerificationEmail
										email={submittedEmail ?? emailWatch}
									/>
									<Anchor
										size="xs"
										onClick={() => setStep(1)}
										style={{ cursor: "pointer" }}
									>
										<Trans>Wrong address? Change email</Trans>
									</Anchor>
								</Stack>
							</Stack>
						)}
					</Stack>
				</form>

				{step !== 2 && (
					<>
						<Divider variant="dashed" label={t`or`} labelPosition="center" />

						<Button
							component={I18nLink}
							to={
								submittedEmail
									? `/login?email=${encodeURIComponent(submittedEmail)}`
									: "/login"
							}
							size="md"
							fullWidth
							{...testId("auth-register-switch-to-login-button")}
						>
							<Trans>Already have an account? Log in</Trans>
						</Button>

						<Box {...testId("auth-register-join-org-help")}>
							<Text size="sm">
								<Trans>Trying to join an existing organisation?</Trans>
							</Text>
							<Anchor
								size="sm"
								onClick={toggleOrgHelp}
								style={{ cursor: "pointer" }}
								{...testId("auth-register-join-org-help-toggle")}
							>
								{orgHelpOpen ? (
									<Trans>Read less</Trans>
								) : (
									<Trans>Read more</Trans>
								)}
							</Anchor>
							<Collapse in={orgHelpOpen}>
								<Stack gap="xs" mt="xs">
									<Text size="sm" c="dimmed">
										<Trans>
											If you're trying to join an existing organisation, you
											should not create a new one. Some reasons that you may
											accidentally end up here are:
										</Trans>
									</Text>
									<List size="sm" c="dimmed" spacing={4}>
										<List.Item>
											<Trans>
												You're logging in with the wrong email address
											</Trans>
										</List.Item>
										<List.Item>
											<Trans>You need an invitation from a colleague</Trans>
										</List.Item>
									</List>
								</Stack>
							</Collapse>
						</Box>
					</>
				)}
			</Stack>
		</div>
	);
};
