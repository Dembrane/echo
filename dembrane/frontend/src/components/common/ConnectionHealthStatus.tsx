import { t } from "@lingui/core/macro";
import { Group, Text } from "@mantine/core";

type Props = {
	isOnline: boolean;
	connectionHealthy: boolean;
};

export const ConnectionHealthStatus = ({
	isOnline,
	connectionHealthy,
}: Props) => {
	const isHealthy = isOnline && connectionHealthy;

	// A healthy connection is the expected case and says nothing a participant
	// can act on. Only trouble earns a line on the screen.
	if (isHealthy) return null;

	return (
		<Group gap="sm" align="center">
			<div
				className="h-2 w-2 rounded-full"
				style={{ background: "var(--app-warning)" }}
			/>
			<Text size="sm" c="var(--app-warning)">
				{t`Connection unhealthy`}
			</Text>
		</Group>
	);
};
