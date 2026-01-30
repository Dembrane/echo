import { Trans } from "@lingui/react/macro";
import { Container, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { testId } from "@/lib/testUtils";

export const CheckYourEmailRoute = () => {
	useDocumentTitle("Check your Email | Dembrane");
	return (
		<Container size="sm">
			<Stack>
				<Title order={1} {...testId("auth-check-email-title")}>
					<Trans>Check your email</Trans>
				</Title>
				<Text {...testId("auth-check-email-text")}>
					<Trans>
						We have sent you an email with next steps. If you don't see it,
						check your spam folder. If you still don't see it, please contact
						evelien@dembrane.com
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
