import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Container,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { useVerifyMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";

export const VerifyEmailRoute = () => {
	useDocumentTitle(t`Email verification | dembrane`);
	const [search] = useSearchParams();
	const token = search.get("token");

	const verifyMutation = useVerifyMutation();

	const runOnlyOnce = useRef(true);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	useEffect(() => {
		if (runOnlyOnce.current && token) {
			runOnlyOnce.current = false;
			verifyMutation.mutate({ token });
		}
	}, [token]);

	// Three explicit states. No toasts — the page is the state.
	// missing-token: user arrived without the ?token= param
	// pending: verifying
	// success: redirecting to /login?verified=1
	// error: broken / expired link
	const missingToken = !token;

	return (
		<Container size="sm" className="!h-full" py="xl">
			<Stack className="h-full">
				<Stack className="flex-grow" gap="md">
					<Title order={2} fw={400}>
						<Trans>Email verification</Trans>
					</Title>

					{missingToken && (
						<Text size="sm" c="dimmed">
							<Trans>
								This link is missing the verification token. Open the
								link from your email again, or{" "}
								<Anchor component={I18nLink} to="/register">
									start over
								</Anchor>
								.
							</Trans>
						</Text>
					)}

					{!missingToken && verifyMutation.isPending && (
						<Group gap="sm">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								<Trans>Verifying your email address.</Trans>
							</Text>
						</Group>
					)}

					{!missingToken && verifyMutation.isSuccess && (
						<Text size="sm" c="dimmed">
							<Trans>
								Your email is verified. Taking you to the login page.
							</Trans>
						</Text>
					)}

					{!missingToken && verifyMutation.isError && (
						<Stack gap={6}>
							<Text size="sm">
								<Trans>
									That link isn't working. It may have expired.
								</Trans>
							</Text>
							<Text size="xs" c="dimmed">
								<Anchor component={I18nLink} to="/register" size="xs">
									<Trans>Request a new verification email</Trans>
								</Anchor>
							</Text>
						</Stack>
					)}
				</Stack>
			</Stack>
		</Container>
	);
};
