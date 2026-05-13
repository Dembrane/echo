import { Trans } from "@lingui/react/macro";
import { Anchor, Container, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useSearchParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { testId } from "@/lib/testUtils";

export const CheckYourEmailRoute = () => {
	useDocumentTitle("Check your email | dembrane");
	// The register flow can pass ?email=… so we echo it back — people
	// stare at this page trying to remember which address they just
	// used, and it's the cheapest way to resolve "wait, did I typo that?"
	const [params] = useSearchParams();
	const email = params.get("email");
	return (
		<Container size="sm" py="xl">
			<Stack gap="md">
				<Title order={2} fw={400} {...testId("auth-check-email-title")}>
					<Trans>Check your email</Trans>
				</Title>
				<Text c="dimmed" {...testId("auth-check-email-text")}>
					{email ? (
						<Trans>
							We sent a verification link to <b>{email}</b>. Click it to
							finish setting up your account.
						</Trans>
					) : (
						<Trans>
							We sent you a verification link. Click it to finish setting
							up your account.
						</Trans>
					)}
				</Text>
				<Stack gap={6}>
					<Text size="xs" c="dimmed">
						<Trans>
							Didn't get it? Check spam or junk first. The message comes
							from dembrane.com.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Used the wrong address?{" "}
							<Anchor component={I18nLink} to="/register" size="xs">
								Register again
							</Anchor>
							.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Still stuck? Email{" "}
							<Anchor href="mailto:support@dembrane.com" size="xs">
								support@dembrane.com
							</Anchor>
							.
						</Trans>
					</Text>
				</Stack>
			</Stack>
		</Container>
	);
};
