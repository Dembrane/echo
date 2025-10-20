import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Container,
	PasswordInput,
	Stack,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useResetPasswordMutation } from "@/components/auth/hooks";

export const PasswordResetRoute = () => {
	useDocumentTitle(t`Reset Password | Dembrane`);
	const [search, _] = useSearchParams();
	const { register, handleSubmit } = useForm<{
		password: string;
		confirmPassword: string;
	}>();
	const [error, setError] = useState("");

	const resetPasswordMutation = useResetPasswordMutation();

	const onSubmit = handleSubmit(async (data) => {
		if (data.password !== data.confirmPassword) {
			setError(t`Passwords do not match`);
			return;
		}

		const token = search.get("token");
		if (!token || token === "") {
			setError(t`Invalid code. Please request a new one.`);
			return;
		}

		resetPasswordMutation.mutate({
			password: data.password,
			token: token,
		});
	});

	return (
		<Container size="sm" className="!h-full">
			<Stack className="h-full">
				<Stack className="flex-grow">
					<Title order={1}>
						<Trans>Reset Password</Trans>
					</Title>

					<form onSubmit={onSubmit}>
						<Stack>
							{error && <Alert color="red">{error}</Alert>}
							<PasswordInput
								label={<Trans>New Password</Trans>}
								size="lg"
								{...register("password")}
								placeholder={t`New Password`}
								required
							/>
							<PasswordInput
								label={<Trans>Confirm New Password</Trans>}
								size="lg"
								{...register("confirmPassword")}
								placeholder={t`Confirm New Password`}
								required
							/>
							<Button
								size="lg"
								type="submit"
								loading={resetPasswordMutation.isPending}
							>
								<Trans>Reset Password</Trans>
							</Button>
						</Stack>
					</form>
				</Stack>
			</Stack>
		</Container>
	);
};
