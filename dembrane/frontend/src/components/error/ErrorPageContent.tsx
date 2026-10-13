import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { DEBUG_MODE } from "@/config";

/**
 * The route error (or 404) message on its own, with no layout around it, so the
 * participant portal can show it without the dashboard's shell and sidebar.
 */
export const ErrorPageContent = () => {
	const error = useRouteError();

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
		<Box className="flex h-[calc(100vh-60px)] flex-col justify-center p-4">
			<Stack gap="md" w="100%" maw={440} mx="auto">
				<Title order={2}>{title}</Title>
				<Text c="dimmed">{message}</Text>
				{DEBUG_MODE && (
					<Paper p="md">
						<pre className="overflow-auto">
							{JSON.stringify(error, null, 2)}
						</pre>
					</Paper>
				)}
				<Group gap="sm">
					{!isNotFound && (
						<Button variant="filled" onClick={() => window.location.reload()}>
							<Trans>Reload page</Trans>
						</Button>
					)}
					<Button
						variant={isNotFound ? "filled" : undefined}
						onClick={() => {
							window.location.href = "/";
						}}
					>
						<Trans>Return home</Trans>
					</Button>
				</Group>
			</Stack>
		</Box>
	);
};
