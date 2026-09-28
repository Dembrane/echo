import { Box, Container, LoadingOverlay } from "@mantine/core";
import type { PropsWithChildren } from "react";
import { useAuthenticated } from "@/components/auth/hooks";

export const Protected = (props: PropsWithChildren) => {
	const { loading, isAuthenticated } = useAuthenticated(true);

	if (loading) {
		return (
			<Container>
				<Box className="relative h-[400px]">
					<LoadingOverlay visible={true} />
				</Box>
			</Container>
		);
	}

	if (!isAuthenticated) {
		return null;
	}

	return <>{props.children}</>;
};
