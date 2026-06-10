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
			return (
				this.props.fallback || (
					<Box className="flex h-[calc(100vh-60px)] flex-col items-center justify-center p-4">
						<Stack align="center" gap="md" maw={420} ta="center">
							<Title order={1}>Something went wrong</Title>
							<Text c="dimmed">
								This part of the page failed to load. Reloading usually fixes
								it. If it keeps happening, head back home.
							</Text>
							<Group>
								<Button onClick={() => window.location.reload()}>
									Reload page
								</Button>
								<Button
									variant="outline"
									onClick={() => {
										this.setState({ hasError: false });
										window.location.href = "/";
									}}
								>
									Return home
								</Button>
							</Group>
						</Stack>
					</Box>
				)
			);
		}

		return this.props.children;
	}
}
