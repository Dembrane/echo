import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Card,
	Group,
	PasswordInput,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { API_BASE_URL } from "@/config";
import { toast } from "../common/Toaster";

export const ChangePasswordCard = () => {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");

	const mutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(
				`${API_BASE_URL}/user-settings/password`,
				{
					body: JSON.stringify({
						current_password: currentPassword,
						new_password: newPassword,
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to change password");
			}
		},
		onSuccess: () => {
			toast.success(t`Password changed`);
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const passwordsMatch = newPassword === confirmPassword;
	const canSubmit =
		currentPassword.trim() !== "" &&
		newPassword.trim() !== "" &&
		newPassword.length >= 8 &&
		passwordsMatch;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconKey size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Change password</Trans>
					</Title>
				</Group>

				<PasswordInput
					label={t`Current password`}
					value={currentPassword}
					onChange={(e) => setCurrentPassword(e.currentTarget.value)}
					placeholder={t`Enter current password`}
				/>

				<PasswordInput
					label={t`New password`}
					value={newPassword}
					onChange={(e) => setNewPassword(e.currentTarget.value)}
					placeholder={t`Enter new password`}
					description={t`Minimum 8 characters`}
				/>

				<PasswordInput
					label={t`Confirm new password`}
					value={confirmPassword}
					onChange={(e) => setConfirmPassword(e.currentTarget.value)}
					placeholder={t`Re-enter new password`}
					error={
						confirmPassword && !passwordsMatch
							? t`Passwords do not match`
							: undefined
					}
				/>

				<Group>
					<Button
						onClick={() => mutation.mutate()}
						loading={mutation.isPending}
						disabled={!canSubmit}
					>
						<Trans>Save</Trans>
					</Button>
				</Group>
			</Stack>
		</Card>
	);
};
