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
	// biome-ignore lint/correctness/noNestedComponentDefinitions: needs to be fixed
	const ListItems = () =>
		Array.from({ length: count }).map((_, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
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
