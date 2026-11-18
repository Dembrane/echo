import { Box, Skeleton, Stack } from "@mantine/core";

interface ProjectListSkeletonProps {
	searchValue: string;
	count?: number;
	wrapper?: boolean;
}

export function ProjectListSkeleton({
	searchValue,
	count = 6,
	wrapper = true,
}: ProjectListSkeletonProps) {
	const items = Array.from({ length: count }).map((_, i) => (
		<Skeleton key={i} height={67} />
	));

	// for pagination, render bare items (no layout wrapper)
	if (!wrapper) {
		return items;
	}

	return (
		<Stack gap="md">
			{searchValue === "" && <Skeleton height={42} className="w-full" />}
			<Box className="relative">
				<Stack gap="sm">{items}</Stack>
			</Box>
		</Stack>
	);
}
