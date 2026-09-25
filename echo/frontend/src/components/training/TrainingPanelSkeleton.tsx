import { Skeleton, Stack } from "@mantine/core";

/** The training panel's heading, its line of explanation and a few rows, as
 * quiet shapes while the roster loads. */
export const TrainingPanelSkeleton = () => (
	<Stack gap="md" aria-busy="true">
		<Stack gap={6}>
			<Skeleton height={14} width={96} radius="sm" />
			<Skeleton height={12} width="60%" radius="sm" />
		</Stack>
		<Stack gap="xs">
			<Skeleton height={56} radius="sm" />
			<Skeleton height={56} radius="sm" />
			<Skeleton height={56} radius="sm" />
		</Stack>
	</Stack>
);
