import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Container, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { useVerifyMutation } from "@/components/auth/hooks";

export const VerifyEmailRoute = () => {
	useDocumentTitle(t`Email Verification | Dembrane`);
	const [search, _setSearch] = useSearchParams();

	const verifyMutation = useVerifyMutation();

	const handleVerify = () => {
		const token = search.get("token");
		if (!token) {
			window.alert(t`Invalid token. Please try again.`);
		}

		verifyMutation.mutate({ token: token ?? "" });
	};

	const runOnlyOnce = useRef(true);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	useEffect(() => {
		if (runOnlyOnce.current) {
			runOnlyOnce.current = false;
			handleVerify();
		}
	}, []);

	return (
		<Container size="sm" className="!h-full">
			<Stack className="h-full">
				<Stack className="flex-grow">
					<Group>
						<Title order={1}>
							<Trans>Email Verification</Trans>
						</Title>
						{verifyMutation.isPending && <Loader />}
					</Group>
					{verifyMutation.isPending && (
						<Text>
							<Trans>Please wait while we verify your email address.</Trans>
						</Text>
					)}
					{verifyMutation.isSuccess && (
						<Text>
							<Trans>
								Email verified successfully. You will be redirected to the login
								page in 5 seconds. If you are not redirected, please click{" "}
								<a href="/login?new=true">here</a>.
							</Trans>
						</Text>
					)}
					{verifyMutation.isError && (
						<Text>
							<Trans>
								There was an error verifying your email. Please try again.
							</Trans>
						</Text>
					)}
				</Stack>
			</Stack>
		</Container>
	);
};
