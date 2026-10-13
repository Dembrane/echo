import { Box, Container, LoadingOverlay } from "@mantine/core";
import { useLocation } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import { BaseLayout } from "../layout/BaseLayout";
import { ErrorPageContent } from "./ErrorPageContent";

export const ErrorPage = () => {
	const location = useLocation();

	// Don't gate on auth on the public auth pages. Everywhere else an invalid
	// session redirects to /login (preserving where the visitor was headed)
	// instead of dead-ending on an error screen. See useAuthenticated's redirect
	// effect. The participant portal uses ParticipantErrorPage instead.
	const skipAuthGate = isAuthPath(location.pathname);
	// When the gate is skipped the session query is disabled entirely.
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

	return (
		<BaseLayout>
			<ErrorPageContent />
		</BaseLayout>
	);
};
