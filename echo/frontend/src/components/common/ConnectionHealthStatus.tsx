import { t } from "@lingui/core/macro";
import { Group, Text } from "@mantine/core";

type Props = {
	isOnline: boolean;
	sseConnectionHealthy: boolean;
};

export const ConnectionHealthStatus = ({
	isOnline,
	sseConnectionHealthy,
}: Props) => {
	const isHealthy = isOnline && sseConnectionHealthy;

	// A healthy connection is the expected case and says nothing a participant
	// can act on. Only trouble earns a line on the screen.
	if (isHealthy) return null;

	return (
		<Group justify="center">
			<Group gap="sm" align="center">
				<div className="h-4 w-4 rounded-full bg-yellow-500 transition-all duration-500 ease-in-out" />
				<Text
					size="xl"
					fw={500}
					c="yellow"
					className="transition-colors duration-500 ease-in-out"
				>
					{t`Connection unhealthy`}
				</Text>
			</Group>
		</Group>
	);
};
