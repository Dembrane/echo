import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Box,
	Button,
	Container,
	Divider,
	PasswordInput,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useRegisterMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { ADMIN_BASE_URL } from "@/config";
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
	const { register, handleSubmit, trigger, getValues, watch } = useForm<{
		email: string;
		password: string;
		confirmPassword: string;
		first_name: string;
		last_name: string;
	}>({
		defaultValues: lockedEmail ? { email: invitedEmail } : undefined,
	});

	const [step, setStep] = useState(0);
	const [error, setError] = useState("");
	const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

	const registerMutation = useRegisterMutation();
	const posthog = usePostHog();

	const handleNext = async () => {
		setError("");
		// Step 0 requires first_name + email
		const valid = await trigger(["first_name", "email"]);
		if (!valid) return;
		const { email } = getValues();
		if (!email.includes("@")) {
			setError(t`Enter a valid email address`);
			return;
		}
		setStep(1);
	};

	const onSubmit = handleSubmit(async (data) => {
		if (data.password.length < 8) {
			setError(t`Password must be at least 8 characters`);
			return;
		}
		if (data.password !== data.confirmPassword) {
			setError(t`Passwords do not match`);
			return;
		}

		posthog?.identify(data.email);
		posthog?.capture("user_registered", {
			email: data.email,
			first_name: data.first_name,
		});

		// Directus rejects empty string on last_name ("INVALID_PAYLOAD:
		// last_name is not allowed to be empty"), so we only include the
		// field when the user actually typed something.
		const extras: Record<string, string> = {
			first_name: data.first_name,
			verification_url: `${ADMIN_BASE_URL}/verify-email`,
		};
		const lastName = data.last_name?.trim();
		if (lastName) extras.last_name = lastName;

		registerMutation.mutate([data.email, data.password, extras], {
			onSuccess: () => {
				setSubmittedEmail(data.email);
				setStep(2);
			},
		});
	});

	const emailWatch = watch("email");

	return (
		<Container size="sm" className="!h-full" py="xl">
			<Stack gap="lg">
				<Stack gap={4}>
					<Title order={2} fw={400}>
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

				<form onSubmit={onSubmit}>
					<Stack gap="md">
						{error && <Alert color="red">{error}</Alert>}
						{registerMutation.error && (
							<Alert color="red">{registerMutation.error.message}</Alert>
						)}

						{step === 0 && (
							<>
								<TextInput
									size="md"
									autoFocus
									label={t`First name`}
									{...register("first_name", { required: true })}
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
									{...register("email", { required: true })}
									{...testId("auth-register-email-input")}
									placeholder={t`john@doe.com`}
									type="email"
									readOnly={lockedEmail}
									description={
										lockedEmail
											? t`Locked to match the invite. To use a different address, ask the admin to re-invite that email.`
											: undefined
									}
									styles={
										lockedEmail
											? {
													input: {
														backgroundColor: "var(--mantine-color-gray-1)",
													},
												}
											: undefined
									}
								/>
								<Button size="md" onClick={handleNext}>
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
									description={t`At least 8 characters`}
									{...register("password", { minLength: 8, required: true })}
									{...testId("auth-register-password-input")}
								/>
								<PasswordInput
									size="md"
									label={t`Confirm password`}
									{...register("confirmPassword", { required: true })}
									{...testId("auth-register-confirm-password-input")}
								/>
								<Box className="flex gap-x-5">
									<Button
										variant="outline"
										size="md"
										onClick={() => setStep(0)}
										className="shrink-0"
									>
										<Trans>Back</Trans>
									</Button>
									<Button
										fullWidth
										size="md"
										type="submit"
										loading={registerMutation.isPending}
										{...testId("auth-register-submit-button")}
									>
										<Trans>Create account</Trans>
									</Button>
								</Box>
							</>
						)}

						{/* Step 2 = inline "check your email" state. Prior flow
						    navigated to a dedicated /check-your-email page,
						    which broke continuity with the stepper and
						    exposed a hard-coded evelien@dembrane contact line.
						    2026-04-23: added wrong-address + stuck affordances —
						    the dead-end screen without recovery was logged as
						    a `[rough]` pain during QA. */}
						{step === 2 && (
							<Stack gap="md" {...testId("auth-register-verify-step")}>
								<Title order={3} fw={400}>
									<Trans>Check your email</Trans>
								</Title>
								<Text c="dimmed">
									<Trans>
										We sent a verification link to{" "}
										<Text span fw={500} c="dark">
											{submittedEmail ?? emailWatch}
										</Text>
										. Click the link to finish setting up your account.
									</Trans>
								</Text>
								<Stack gap={6}>
									<Text size="xs" c="dimmed">
										<Trans>
											Didn't get it? Check spam or junk. The message comes from
											dembrane.com.
										</Trans>
									</Text>
									<Anchor
										size="xs"
										onClick={() => {
											// Back to step 1 so they can re-enter the
											// email. The form values persist, so a typo
											// fix is one keystroke.
											setStep(1);
										}}
										style={{ cursor: "pointer" }}
									>
										<Trans>Wrong address? Change email</Trans>
									</Anchor>
									{/* Support line removed 2026-04-24: we don't want
									    to advertise support inboxes during demo prep. */}
								</Stack>
							</Stack>
						)}
					</Stack>
				</form>

				{step !== 2 && (
					<>
						<Divider variant="dashed" label={t`or`} labelPosition="center" />

						{/* Pass the just-registered email through so Login.tsx
						    can pre-fill + lock the email field, blocking Chrome's
						    autofill from quietly swapping in a different saved
						    account on submit. */}
						<I18nLink
							to={
								submittedEmail
									? `/login?email=${encodeURIComponent(submittedEmail)}`
									: "/login"
							}
						>
							<Button
								size="md"
								variant="outline"
								fullWidth
								{...testId("auth-register-switch-to-login-button")}
							>
								<Trans>Already have an account? Log in</Trans>
							</Button>
						</I18nLink>
					</>
				)}
			</Stack>
		</Container>
	);
};
