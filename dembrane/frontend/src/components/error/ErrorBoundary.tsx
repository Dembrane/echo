import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import posthog from "posthog-js";
import { Component, type ErrorInfo, type PropsWithChildren } from "react";

interface Props {
	fallback?: React.ReactNode;
}

interface State {
	hasError: boolean;
	error?: Error;
}

export class ErrorBoundary extends Component<PropsWithChildren<Props>, State> {
	public state: State = {
		hasError: false,
	};

	public static getDerivedStateFromError(error: Error): State {
		return { error, hasError: true };
	}

	public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error("Uncaught error:", error, errorInfo);
		// React swallows render errors before they reach window.onerror, so the
		// init-level autocapture never sees them. Report them here instead.
		posthog.captureException(error, {
			component_stack: errorInfo.componentStack,
		});
	}

	public render() {
		if (this.state.hasError) {
			// `fallback={null}` means "render nothing on error", so only fall
			// through to the default screen when the prop was omitted entirely.
			if (this.props.fallback !== undefined) {
				return this.props.fallback;
			}
			return (
				<Box className="flex h-[calc(100vh-60px)] flex-col justify-center p-4">
					<Stack gap="md" w="100%" maw={440} mx="auto">
						<Title order={2}>
							<Trans>Something went wrong</Trans>
						</Title>
						<Text c="dimmed">
							<Trans>
								This part of the page failed to load. Reloading usually fixes
								it. If it keeps happening, head back home.
							</Trans>
						</Text>
						<Group gap="sm">
							<Button variant="filled" onClick={() => window.location.reload()}>
								<Trans>Reload page</Trans>
							</Button>
							<Button
								onClick={() => {
									this.setState({ hasError: false });
									window.location.href = "/";
								}}
							>
								<Trans>Return home</Trans>
							</Button>
						</Group>
					</Stack>
				</Box>
			);
		}

		return this.props.children;
	}
}
