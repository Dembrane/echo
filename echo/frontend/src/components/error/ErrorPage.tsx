import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Container,
	Group,
	LoadingOverlay,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import { DEBUG_MODE, USE_PARTICIPANT_ROUTER } from "@/config";
import { BaseLayout } from "../layout/BaseLayout";

export const ErrorPage = () => {
	const error = useRouteError();
	const location = useLocation();

	// Don't gate on auth for the participant portal (participants don't log in)
	// or on the public auth pages. Everywhere else an invalid session redirects
	// to /login (preserving where the visitor was headed) instead of dead-ending
	// on an error screen. See useAuthenticated's redirect effect.
	const skipAuthGate = USE_PARTICIPANT_ROUTER || isAuthPath(location.pathname);
	// When the gate is skipped the session query is disabled entirely, so the
	// participant portal never fires a doomed refresh call.
	const { loading, isAuthenticated } = useAuthenticated(
		!skipAuthGate,
		!skipAuthGate,
	);

	// While the session check runs, or while we redirect an unauthenticated
	// visitor to login, show a spinner rather than flashing an error.
	if (!skipAuthGate && (loading || !isAuthenticated)) {
		return (
			<Container>
				<Box className="relative h-[400px]">
					<LoadingOverlay visible={true} />
				</Box>
			</Container>
		);
	}

	// An unmatched URL (catch-all route) carries no route error: treat as 404.
	const isNotFound =
		!error || (isRouteErrorResponse(error) && error.status === 404);

	const title = isRouteErrorResponse(error) ? (
		`${error.status} ${error.statusText}`
	) : isNotFound ? (
		<Trans>Page not found</Trans>
	) : (
		<Trans>Something went wrong</Trans>
	);

	const message =
		(isRouteErrorResponse(error) && error.data?.message) ||
		(isNotFound ? (
			<Trans>
				We couldn't find the page you were looking for. It may have moved.
			</Trans>
		) : (
			<Trans>
				An unexpected error occurred. Reloading or returning home usually helps.
			</Trans>
		));

	return (
		<BaseLayout>
			<Box className="flex h-[calc(100vh-60px)] flex-col items-center justify-center p-4">
				<Stack align="center" gap="md" maw={440} ta="center">
					<Title order={1}>{title}</Title>
					<Text c="dimmed">{message}</Text>
					{DEBUG_MODE && (
						<div className="rounded-md border border-red-500 bg-gray-100 p-4">
							<pre>{JSON.stringify(error, null, 2)}</pre>
						</div>
					)}
					<Group>
						{!isNotFound && (
							<Button onClick={() => window.location.reload()}>
								<Trans>Reload page</Trans>
							</Button>
						)}
						<Button
							variant={isNotFound ? "filled" : "outline"}
							onClick={() => {
								window.location.href = "/";
							}}
						>
							<Trans>Return home</Trans>
						</Button>
					</Group>
				</Stack>
			</Box>
		</BaseLayout>
	);
};
