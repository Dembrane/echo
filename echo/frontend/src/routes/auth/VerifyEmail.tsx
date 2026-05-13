import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
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
import { useAuthenticated, useVerifyMutation } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

// Email link target: /verify-email?token=...
// First click verifies; later clicks short-circuit on auth state or
// Directus's INVALID_TOKEN. 15s mutation timeout prevents the original
// infinite-loading bug.
export const VerifyEmailRoute = () => {
	useDocumentTitle(t`Email verification | dembrane`);
	const [search] = useSearchParams();
	const token = search.get("token");
	const navigate = useI18nNavigate();
	const { isAuthenticated, loading: authLoading } = useAuthenticated();

	// doRedirect=false — we route ourselves so login vs dashboard is
	// decided in one place.
	const verifyMutation = useVerifyMutation(false);

	const ranRef = useRef(false);

	useEffect(() => {
		// Wait for the session check first — firing before we know auth
		// state was the cause of the infinite-loading race. Authenticated
		// users skip the call entirely (token is stale → misleading error).
		if (authLoading) return;
		if (!token) return;
		if (ranRef.current) return;
		if (isAuthenticated) return;

		ranRef.current = true;
		verifyMutation.mutate(
			{ token },
			{
				onSuccess: () => {
					setTimeout(() => navigate("/login?verified=1"), 1500);
				},
			},
		);
	}, [authLoading, isAuthenticated, token, verifyMutation, navigate]);

	const missingToken = !token;
	const showAlreadyVerified = !missingToken && !authLoading && isAuthenticated;
	const showVerifying =
		!missingToken &&
		!authLoading &&
		!isAuthenticated &&
		verifyMutation.isPending;
	const showSuccess = !missingToken && verifyMutation.isSuccess;
	const showError = !missingToken && verifyMutation.isError;
	const showSessionLoading = !missingToken && authLoading;

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
								Something went wrong. Please open the link from your email
								again, or{" "}
								<Anchor component={I18nLink} to="/register">
									start over
								</Anchor>
								.
							</Trans>
						</Text>
					)}

					{showSessionLoading && (
						<Group gap="sm">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								<Trans>Checking your session.</Trans>
							</Text>
						</Group>
					)}

					{/* Authenticated → token already did its job; skip the call. */}
					{showAlreadyVerified && (
						<Stack gap="sm">
							<Alert color="blue" variant="light">
								<Stack gap={4}>
									<Text size="sm" fw={500}>
										<Trans>Your email is already verified</Trans>
									</Text>
									<Text size="xs">
										<Trans>
											This link has already been used. You're signed in and
											ready to go.
										</Trans>
									</Text>
								</Stack>
							</Alert>
							<Button size="md" onClick={() => navigate("/projects")}>
								<Trans>Go to dashboard</Trans>
							</Button>
						</Stack>
					)}

					{showVerifying && (
						<Group gap="sm">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								<Trans>Verifying your email address.</Trans>
							</Text>
						</Group>
					)}

					{showSuccess && (
						<Text size="sm" c="dimmed">
							<Trans>
								Your email is verified. Taking you to the login page.
							</Trans>
						</Text>
					)}

					{/* Failure → most people are actually already verified;
					    Log in is the realistic action. No resend CTA: Directus
					    doesn't expose one and the old button silently failed. */}
					{showError && (
						<Stack gap="xl">
							<Alert color="yellow" variant="light">
								<Stack>
									<Text size="sm" fw={500}>
										<Trans>This link is no longer valid</Trans>
									</Text>
									<Text size="xs">
										<Trans>
											It may have already been used or expired. If your email is
											verified, log in to continue.
										</Trans>
									</Text>
								</Stack>
							</Alert>
							<Stack gap="lg">
								<Button size="md" onClick={() => navigate("/login")} fullWidth>
									<Trans>Log in</Trans>
								</Button>
								<Text size="xs" c="dimmed" ta="center">
									<Trans>
										Trouble logging in? Contact support@dembrane.com.
									</Trans>
								</Text>
							</Stack>
						</Stack>
					)}
				</Stack>
			</Stack>
		</Container>
	);
};
