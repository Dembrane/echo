import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Box,
	Button,
	Collapse,
	Divider,
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
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useRegisterMutation } from "@/components/auth/hooks";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { I18nLink } from "@/components/common/i18nLink";
import { ADMIN_BASE_URL } from "@/config";
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
	const { register, handleSubmit, trigger, getValues, watch, control } =
		useForm<{
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
	const [orgHelpOpen, { toggle: toggleOrgHelp }] = useDisclosure(false);

	const registerMutation = useRegisterMutation();
	const posthog = usePostHog();

	const handleNext = async () => {
		setError("");
		const valid = await trigger(["first_name", "email"]);
		if (!valid) return;
		const { email } = getValues();
		if (!email.includes("@")) {
			setError(t`Enter a valid email address`);
			return;
		}
		// Funnel step: $pageview (/register) -> registration_details_completed
		// -> user_registered. Time between steps shows where people stall.
		posthog?.capture("registration_details_completed", {
			from_invite: lockedEmail,
		});
		setStep(1);
	};

	const onSubmit = handleSubmit(async (data) => {
		setError("");
		if (!validatePassword(data.password).isValid) {
			setError(t`Password does not meet the requirements.`);
			return;
		}
		if (data.password !== data.confirmPassword) {
			setError(t`Passwords do not match`);
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

	const emailWatch = watch("email");
	// useWatch, not watch(): React Compiler memoizes watch() so it never updates.
	const password = useWatch({ control, name: "password" }) ?? "";

	return (
		<div className="h-full w-full">
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
									{...register("password", { required: true })}
									{...testId("auth-register-password-input")}
								/>
								<PasswordRequirements value={password} />
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
										disabled={!validatePassword(password).isValid}
										{...testId("auth-register-submit-button")}
									>
										<Trans>Create account</Trans>
									</Button>
								</Box>
							</>
						)}

						{step === 2 && (
							<Stack gap="md" {...testId("auth-register-verify-step")}>
								<Title order={3} fw={400}>
									<Trans>Check your email</Trans>
								</Title>
								<Text c="dimmed">
									<Trans>
										We've sent a verification link to{" "}
										<Text span fw={500} c="dark">
											{submittedEmail ?? emailWatch}
										</Text>
										. Open the email and click the link to continue.
									</Trans>
								</Text>
								<Stack gap={6}>
									<Text size="xs" c="dimmed">
										<Trans>
											Didn't get it? Check your spam or junk folder. The email
											comes from dembrane.com.
										</Trans>
									</Text>
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

						<Box {...testId("auth-register-join-org-help")}>
							<Text size="sm" fw={500}>
								<Trans>Trying to join an existing organization?</Trans>
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
									<Trans>Read more →</Trans>
								)}
							</Anchor>
							<Collapse in={orgHelpOpen}>
								<Stack gap={6} mt="xs">
									<Text size="sm" c="dimmed">
										<Trans>
											If you're trying to join an existing organization, you
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
