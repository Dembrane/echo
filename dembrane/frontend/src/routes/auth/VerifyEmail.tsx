import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
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
// The token names the address it verifies, so the call is made whoever is
// signed in: a link opened in a browser where someone else is signed in still
// verifies its own address, and the session stays as it is. A link clicked a
// second time answers as verified until it expires; an expired or broken one
// fails, signed in or not. 15s mutation timeout prevents the original
// infinite-loading bug.
export const VerifyEmailRoute = () => {
	useDocumentTitle(t`Email verification | dembrane`);
	const [search] = useSearchParams();
	const token = search.get("token");
	const navigate = useI18nNavigate();
	const { isAuthenticated, loading: authLoading } = useAuthenticated();

	// doRedirect=false: we route ourselves so login vs dashboard is
	// decided in one place.
	const verifyMutation = useVerifyMutation(false);

	const ranRef = useRef(false);

	useEffect(() => {
		// Wait for the session check first: firing before we know auth
		// state was the cause of the infinite-loading race.
		if (authLoading) return;
		if (!token) return;
		if (ranRef.current) return;

		ranRef.current = true;
		verifyMutation.mutate(
			{ token },
			{
				onSuccess: () => {
					// Someone signed in stays where they are: the login page is not
					// their next step.
					if (isAuthenticated) return;
					setTimeout(() => navigate("/login?verified=1"), 1500);
				},
			},
		);
	}, [authLoading, isAuthenticated, token, verifyMutation, navigate]);

	const missingToken = !token;
	const signedIn = !authLoading && isAuthenticated;
	const showVerifying =
		!missingToken && !authLoading && verifyMutation.isPending;
	const showSuccess = !missingToken && !signedIn && verifyMutation.isSuccess;
	const showVerifiedSignedIn =
		!missingToken && signedIn && verifyMutation.isSuccess;
	const showError = !missingToken && !authLoading && verifyMutation.isError;
	const showSessionLoading = !missingToken && authLoading;

	return (
		<div className="h-full w-full">
			<Stack className="h-full">
				<Stack className="flex-grow" gap="md">
					<Title order={2}>
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

					{showVerifiedSignedIn && (
						<Stack gap="xl">
							<Text size="sm" c="dimmed">
								<Trans>
									The email address this link was sent to is verified. You are
									still signed in to your own account here.
								</Trans>
							</Text>
							<Button
								variant="filled"
								size="md"
								onClick={() => navigate("/o")}
								fullWidth
							>
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

					{/* Failure: signed out, most people are actually already verified, so
					    Log in is the realistic action, and login offers a resend if not.
					    Signed in, the link may be someone else's: nothing is claimed about
					    whose address is verified. */}
					{showError && (
						<Stack gap="xl">
							<Alert color="yellow" variant="light">
								<Stack>
									<Text size="sm">
										<Trans>This link is no longer valid</Trans>
									</Text>
									<Text size="xs">
										{signedIn ? (
											<Trans>
												It may have expired. You are still signed in to your own
												account here.
											</Trans>
										) : (
											<Trans>
												It may have already been used or expired. If your email
												is verified, log in to continue.
											</Trans>
										)}
									</Text>
								</Stack>
							</Alert>
							{signedIn ? (
								<Button
									variant="filled"
									size="md"
									onClick={() => navigate("/o")}
									fullWidth
								>
									<Trans>Go to dashboard</Trans>
								</Button>
							) : (
								<Stack gap="lg">
									<Button
										variant="filled"
										size="md"
										onClick={() => navigate("/login")}
										fullWidth
									>
										<Trans>Log in</Trans>
									</Button>
									<Text size="xs" c="dimmed">
										<Trans>
											Trouble logging in? Contact support@dembrane.com.
										</Trans>
									</Text>
								</Stack>
							)}
						</Stack>
					)}
				</Stack>
			</Stack>
		</div>
	);
};
