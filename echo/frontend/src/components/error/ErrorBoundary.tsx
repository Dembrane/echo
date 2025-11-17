import { Box, Button, Text, Title } from "@mantine/core";
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
	}

	public render() {
		if (this.state.hasError) {
			return (
				this.props.fallback || (
					<Box className="flex h-[calc(100vh-60px)] flex-col items-center justify-center gap-4 p-4">
						<Title order={1}>Oops, something went wrong!</Title>
						<Text>We apologize for the inconvenience.</Text>
						<Button
							onClick={() => {
							this.setState({ hasError: false });
							window.location.href = "/projects";
						}}
						>
							Return to Projects
						</Button>
					</Box>
				)
			);
		}

		return this.props.children;
	}
}
