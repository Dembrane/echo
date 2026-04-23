import { Trans } from "@lingui/react/macro";
import { Container, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { testId } from "@/lib/testUtils";

export const CheckYourEmailRoute = () => {
	useDocumentTitle("Check your email | dembrane");
	return (
		<Container size="sm" py="xl">
			<Stack gap="sm">
				<Title order={2} fw={400} {...testId("auth-check-email-title")}>
					<Trans>Check your email</Trans>
				</Title>
				<Text c="dimmed" {...testId("auth-check-email-text")}>
					<Trans>
						We sent you a verification link. Click the link to finish setting
						up your account.
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
