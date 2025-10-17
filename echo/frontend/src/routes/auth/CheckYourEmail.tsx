import { Trans } from "@lingui/react/macro";
import { Container, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";

export const CheckYourEmailRoute = () => {
	useDocumentTitle("Check your Email | Dembrane");
	return (
		<Container size="sm">
			<Stack>
				<Title order={1}>
					<Trans>Check your email</Trans>
				</Title>
				<Text>
					<Trans>
						We have sent you an email with next steps. If you don't see it,
						check your spam folder. If you still don't see it, please contact
						jules@dembrane.com
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
