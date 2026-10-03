import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { testId } from "@/lib/testUtils";
import { useResendVerificationMutation } from "./hooks";
import { describeAuthError } from "./utils/errorUtils";

const COOLDOWN_SECONDS = 60;

/** Sends a fresh verification link to `email`, then waits a minute before another. */
export const ResendVerificationEmail = ({ email }: { email: string }) => {
	const resend = useResendVerificationMutation();
	const [wait, setWait] = useState(0);

	useEffect(() => {
		if (wait <= 0) return;
		const id = setTimeout(() => setWait((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [wait]);

	const send = () =>
		resend.mutate(email, { onSuccess: () => setWait(COOLDOWN_SECONDS) });

	return (
		<Stack gap={4} align="flex-start">
			<Button
				variant="subtle"
				size="compact-sm"
				px={0}
				loading={resend.isPending}
				disabled={wait > 0}
				onClick={send}
				{...testId("auth-resend-verification")}
			>
				<Trans>Resend verification email</Trans>
			</Button>
			{resend.isSuccess && (
				<Text size="xs" c="dimmed">
					{wait > 0
						? t`We sent a new verification link. You can send another in ${wait} seconds.`
						: t`We sent a new verification link.`}
				</Text>
			)}
			{resend.isError && (
				<Alert color="red">{describeAuthError(resend.error)}</Alert>
			)}
		</Stack>
	);
};
