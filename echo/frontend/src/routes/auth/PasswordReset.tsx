import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, PasswordInput, Stack, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useSearchParams } from "react-router";
import { useResetPasswordMutation } from "@/components/auth/hooks";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { validatePassword } from "@/lib/passwordPolicy";

export const PasswordResetRoute = () => {
	useDocumentTitle(t`Reset Password | dembrane`);
	const [search, _] = useSearchParams();
	const { register, handleSubmit, control } = useForm<{
		password: string;
		confirmPassword: string;
	}>();
	const [error, setError] = useState("");

	const resetPasswordMutation = useResetPasswordMutation();
	// useWatch, not watch(): React Compiler memoizes watch() so it never updates.
	const password = useWatch({ control, name: "password" }) ?? "";

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
		<div className="h-full w-full">
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
							<PasswordRequirements value={password} />
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
								disabled={!validatePassword(password).isValid}
							>
								<Trans>Reset Password</Trans>
							</Button>
						</Stack>
					</form>
				</Stack>
			</Stack>
		</div>
	);
};
