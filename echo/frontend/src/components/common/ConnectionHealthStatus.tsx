import { t } from "@lingui/core/macro";
import { Group, Text } from "@mantine/core";
import clsx from "clsx";

type Props = {
	isOnline: boolean;
	sseConnectionHealthy: boolean;
};

export const ConnectionHealthStatus = ({
	isOnline,
	sseConnectionHealthy,
}: Props) => {
	const isHealthy = isOnline && sseConnectionHealthy;

	return (
		<Group justify="center">
			<Group gap="sm" align="center">
				<div
					className={clsx(
						"h-3 w-3 rounded-full transition-all duration-500 ease-in-out",
						isHealthy ? "bg-green-500" : "bg-yellow-500",
					)}
				/>
				<Text
					size="md"
					c={isHealthy ? "green" : "yellow"}
					className="transition-colors duration-500 ease-in-out"
				>
					{isHealthy ? t`Connection healthy` : t`Connection unhealthy`}
				</Text>
			</Group>
		</Group>
	);
};
