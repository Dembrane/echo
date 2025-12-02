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
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useLoginMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { useCreateProjectMutation } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

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
	useDocumentTitle(t`Login | Dembrane`);
	const { register, handleSubmit, setValue, getValues } = useForm<{
		email: string;
		password: string;
		otp: string;
	}>({
		defaultValues: {
			otp: "",
		},
		shouldUnregister: false,
	});

	const [searchParams, _setSearchParams] = useSearchParams();

	const navigate = useI18nNavigate();
	const createProjectMutation = useCreateProjectMutation();
	const { runTransition } = useTransitionCurtain();

	const [error, setError] = useState("");
	const [otpRequired, setOtpRequired] = useState(false);
	const [otpValue, setOtpValue] = useState("");
	const [formParent] = useAutoAnimate();
	const pinInputRef = useRef<HTMLDivElement | null>(null);
	const loginMutation = useLoginMutation();

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

			const isNewUser = searchParams.get("new") === "true";
			const next = searchParams.get("next");
			const transitionPromise = runTransition({
				message: isNewUser ? t`Setting up your first project` : t`Welcome back`,
			});

			if (isNewUser) {
				toast(t`Setting up your first project`);
				const project = await createProjectMutation.mutateAsync({
					name: t`New Project`,
				});
				await transitionPromise;
				navigate(`/projects/${project.id}`);
				return;
			}

			await transitionPromise;
			if (!!next && next !== "/login") {
				navigate(next);
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

					{(searchParams.get("new") === "true" ||
						!!searchParams.get("next")) && (
						<Text>
							<Trans>Please login to continue.</Trans>
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
										placeholder={t`Email`}
										required
										type="email"
									/>
									<PasswordInput
										label={<Trans>Password</Trans>}
										size="lg"
										{...register("password")}
										placeholder={t`Password`}
										required
									/>
								</>
							)}
							{!otpRequired && (
								<div className="w-full text-right">
									<I18nLink to="/request-password-reset">
										<Anchor variant="outline">
											<Trans>Forgot your password?</Trans>
										</Anchor>
									</I18nLink>
								</div>
							)}
							<Button size="lg" type="submit" loading={loginMutation.isPending}>
								{otpRequired ? (
									<Trans>Verify code</Trans>
								) : (
									<Trans>Login</Trans>
								)}
							</Button>
						</Stack>
					</form>

					<Divider variant="dashed" label="or" labelPosition="center" />

					<I18nLink to="/register">
						<Button size="lg" variant="outline" fullWidth>
							<Trans>Register as a new user</Trans>
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
