import { Trans } from "@lingui/react/macro";
import { Alert, Anchor, Button, Stack, Text } from "@mantine/core";
import { ShieldWarningIcon } from "@phosphor-icons/react";
import { SUPPORT_EMAIL } from "@/components/error/actions";
import { testId } from "@/lib/testUtils";

/**
 * A login refused before it reached dembrane (a 403 that carries no dembrane code). It
 * says only what is known, offers the emailed sign-in code when the page has one, and
 * names support. It never guesses the cause.
 */
export const LoginBlockedNotice = ({
	onUseCode,
}: {
	/** Switches to the emailed sign-in code; the button is left out without it. */
	onUseCode?: () => void;
}) => (
	<Alert
		color="red"
		icon={<ShieldWarningIcon size={20} />}
		{...testId("auth-login-blocked")}
	>
		<Stack gap="xs" align="flex-start">
			<Text size="sm">
				<Trans>
					Your login was stopped before it reached dembrane, so we could not
					check your details. Try another network or another browser.
				</Trans>
			</Text>
			{onUseCode && (
				<Button
					size="xs"
					variant="outline"
					onClick={onUseCode}
					{...testId("auth-login-blocked-use-code")}
				>
					<Trans>Email me a sign-in code instead</Trans>
				</Button>
			)}
			<Text size="sm">
				<Trans>
					Still stuck? Email{" "}
					<Anchor href={`mailto:${SUPPORT_EMAIL}`} inherit>
						{SUPPORT_EMAIL}
					</Anchor>{" "}
					and we will help you log in.
				</Trans>
			</Text>
		</Stack>
	</Alert>
);
