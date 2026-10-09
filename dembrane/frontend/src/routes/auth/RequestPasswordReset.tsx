import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Anchor, Button, Stack, TextInput, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useRequestPasswordResetMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { testId } from "@/lib/testUtils";

export const RequestPasswordResetRoute = () => {
	useDocumentTitle(t`Request password reset | dembrane`);
	// The "you already have an account" email links here with ?email=.
	const [searchParams] = useSearchParams();
	const { register, handleSubmit } = useForm<{ email: string }>({
		defaultValues: { email: searchParams.get("email") ?? "" },
	});

	const requestPasswordResetMutation = useRequestPasswordResetMutation();

	const onSubmit = handleSubmit(async (data) => {
		requestPasswordResetMutation.mutate(data.email);
	});

	return (
		<div className="h-full w-full">
			<Stack className="h-full">
				<Stack className="flex-grow">
					<Title order={2}>
						<Trans>Request password reset</Trans>
					</Title>

					{requestPasswordResetMutation.isSuccess ? (
						<Stack {...testId("auth-password-reset-sent")}>
							<Alert color="green" variant="light">
								<Trans>
									If an account exists for{" "}
									<b>{requestPasswordResetMutation.variables}</b>, we sent it a
									link to reset your password. Check your inbox and spam folder.
								</Trans>
							</Alert>
							<Anchor component={I18nLink} to="/login" size="sm">
								<Trans>Back to log in</Trans>
							</Anchor>
						</Stack>
					) : (
						<form onSubmit={onSubmit}>
							<Stack>
								<TextInput
									size="md"
									label={t`Email`}
									{...register("email")}
									{...testId("auth-password-reset-email-input")}
									placeholder={t`Email`}
									required
									type="email"
								/>
								<Button
									mt="xs"
									variant="filled"
									size="md"
									type="submit"
									loading={requestPasswordResetMutation.isPending}
									{...testId("auth-password-reset-submit-button")}
								>
									<Trans>Send reset link</Trans>
								</Button>
							</Stack>
						</form>
					)}
				</Stack>
			</Stack>
		</div>
	);
};
