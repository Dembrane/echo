import { Trans } from "@lingui/react/macro";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { InfoIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

/**
 * The sign-in worked, but a step after it (loading the active devices, the landing page)
 * did not. The person is logged in; this says so and lets them carry on.
 */
export const SignedInRecoveryNotice = ({
	onContinue,
	loading = false,
}: {
	onContinue: () => void;
	loading?: boolean;
}) => (
	<Alert
		icon={<InfoIcon size={20} />}
		{...testId("auth-login-signed-in-retry")}
	>
		<Stack gap="xs" align="flex-start">
			<Text size="sm">
				<Trans>
					You are logged in, but we could not open dembrane just now. Try again
					in a moment.
				</Trans>
			</Text>
			<Button
				size="xs"
				loading={loading}
				onClick={onContinue}
				{...testId("auth-login-signed-in-continue")}
			>
				<Trans>Continue</Trans>
			</Button>
		</Stack>
	</Alert>
);
