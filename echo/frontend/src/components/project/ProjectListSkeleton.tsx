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
	const ListItems = () =>
		Array.from({ length: count }).map((_, i) => (
			<Skeleton key={i} height={67} radius="sm" />
		));

	// for pagination, render bare items (no layout wrapper)
	if (!wrapper) {
		return <ListItems />;
	}

	return (
		<Stack gap="md">
			{searchValue === "" && (
				<Skeleton height={42} radius="sm" className="w-full" />
			)}
			<Box className="relative">
				<Stack gap="sm">
					<ListItems />
				</Stack>
			</Box>
		</Stack>
	);
}
